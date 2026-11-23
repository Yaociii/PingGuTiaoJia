import type {
  CostConfig,
  GoodItem,
  PriceStep,
  RebalanceResult,
  RebalanceStatus,
  SecondarySettlementResult,
  SettlementRow,
} from '../types/pricing';

export function roundTo2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value: number): string {
  const rounded = roundTo2(value);
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1).replace(/\.0$/, '');
}

/**
 * 计算目标总价：
 * - direct 模式直接返回 cost.targetTotal（非负）
 * - foreign 模式：roundTo2((foreignPrice * exchangeRate + shippingFee) * (1 + feeRate))
 */
export function calcTargetTotal(cost: CostConfig): number {
  if (cost.mode === 'foreign') {
    const base =
      Math.max(0, Number.isFinite(cost.foreignPrice) ? cost.foreignPrice : 0) *
        Math.max(0, Number.isFinite(cost.exchangeRate) ? cost.exchangeRate : 0) +
      Math.max(0, Number.isFinite(cost.shippingFee) ? cost.shippingFee : 0);
    const feeRate = Math.max(0, Number.isFinite(cost.feeRate) ? cost.feeRate : 0);
    return roundTo2(base * (1 + feeRate));
  }
  return roundTo2(Math.max(0, Number.isFinite(cost.targetTotal) ? cost.targetTotal : 0));
}

/**
 * 计算有效平均单价（仅统计 quantity > 0 的单品）
 */
export function calcEffectiveAvgPrice(items: GoodItem[]): number {
  let totalQty = 0;
  let totalAmount = 0;
  for (const item of items) {
    if (item.quantity > 0) {
      totalQty += item.quantity;
      totalAmount += item.price * item.quantity;
    }
  }
  if (totalQty <= 0) return 0;
  return roundTo2(totalAmount / totalQty);
}

interface InternalSlot {
  index: number;
  weight: number;
  quantity: number;
  minPrice: number;
  maxPrice: number;
  idealPrice: number;
  boundLocked: boolean;
  boundPrice: number;
  units: number;
  minUnits: number;
  maxUnits: number;
  remainder: number;
}

function stepToMultiplier(step: PriceStep): number {
  // Using integer scaling avoids floating-point drift (step=0.5 -> 2, step=1 -> 1, step=5 -> 0.2)
  return 1 / step;
}

/**
 * 总价守恒平账引擎（纯函数）
 * 约束：sum(price_i * quantity_i) = targetTotal
 */
export function rebalanceItems(
  inputItems: GoodItem[],
  targetTotalRaw: number,
  step: PriceStep = 1
): RebalanceResult {
  const targetTotal = roundTo2(Math.max(0, Number.isFinite(targetTotalRaw) ? targetTotalRaw : 0));
  const items: GoodItem[] = inputItems.map((it) => ({ ...it }));

  // 1. 零数量项直接归零，不参与分配
  for (const item of items) {
    if (!Number.isFinite(item.quantity) || item.quantity <= 0) {
      item.quantity = 0;
      item.price = 0;
    } else {
      item.quantity = Math.floor(item.quantity);
    }
  }

  const activeIndices: number[] = [];
  const lockedIndices: number[] = [];
  const unlockedIndices: number[] = [];

  items.forEach((item, idx) => {
    if (item.quantity > 0) {
      activeIndices.push(idx);
      if (item.locked) {
        lockedIndices.push(idx);
      } else {
        unlockedIndices.push(idx);
      }
    }
  });

  if (activeIndices.length === 0) {
    return {
      items,
      targetTotal,
      actualTotal: 0,
      residual: roundTo2(-targetTotal),
      status: targetTotal === 0 ? 'OK' : 'NO_UNLOCKED_ITEMS',
      exceedAmount: 0,
    };
  }

  let lockedTotal = 0;
  for (const idx of lockedIndices) {
    items[idx].price = roundTo2(Math.max(0, Number.isFinite(items[idx].price) ? items[idx].price : 0));
    lockedTotal += items[idx].price * items[idx].quantity;
  }
  lockedTotal = roundTo2(lockedTotal);

  const remainingBudget = roundTo2(targetTotal - lockedTotal);

  // 2. 无未锁定有效项
  if (unlockedIndices.length === 0) {
    const residual = roundTo2(lockedTotal - targetTotal);
    return {
      items,
      targetTotal,
      actualTotal: lockedTotal,
      residual,
      status: Math.abs(residual) < 0.005 ? 'OK' : 'NO_UNLOCKED_ITEMS',
      exceedAmount: residual > 0 ? residual : 0,
    };
  }

  // 3. 锁定超额保护：严禁出现负价
  if (remainingBudget < 0) {
    for (const idx of unlockedIndices) {
      items[idx].price = 0;
    }
    const exceedAmount = roundTo2(Math.abs(remainingBudget));
    return {
      items,
      targetTotal,
      actualTotal: lockedTotal,
      residual: exceedAmount,
      status: 'LOCKED_EXCEEDS_TARGET',
      exceedAmount,
    };
  }

  // 4. Water-filling 迭代处理上下限约束 [minPrice, maxPrice]
  const slots: InternalSlot[] = unlockedIndices.map((index) => {
    const item = items[index];
    const minP =
      item.minPrice !== undefined && Number.isFinite(item.minPrice)
        ? Math.max(0, item.minPrice)
        : 0;
    const maxP =
      item.maxPrice !== undefined && Number.isFinite(item.maxPrice)
        ? Math.max(minP, item.maxPrice)
        : Number.POSITIVE_INFINITY;

    return {
      index,
      weight: Math.max(Number.isFinite(item.weight) ? item.weight : 1, 0.01),
      quantity: item.quantity,
      minPrice: minP,
      maxPrice: maxP,
      idealPrice: 0,
      boundLocked: false,
      boundPrice: 0,
      units: 0,
      minUnits: Math.ceil(minP / step - 1e-9),
      maxUnits: Number.isFinite(maxP) ? Math.floor(maxP / step + 1e-9) : Number.MAX_SAFE_INTEGER,
      remainder: 0,
    };
  });

  // Ensure minUnits <= maxUnits
  for (const s of slots) {
    if (s.minUnits > s.maxUnits) {
      s.maxUnits = s.minUnits;
    }
  }

  let poolBudget = remainingBudget;
  for (let iter = 0; iter <= slots.length; iter++) {
    const freeSlots = slots.filter((s) => !s.boundLocked);
    if (freeSlots.length === 0) break;

    const totalWeightedQty = freeSlots.reduce((sum, s) => sum + s.weight * s.quantity, 0);
    if (totalWeightedQty <= 0) {
      for (const s of freeSlots) s.idealPrice = 0;
      break;
    }

    let anyViolated = false;
    for (const s of freeSlots) {
      const ideal = Math.max(0, poolBudget) * (s.weight / totalWeightedQty);
      if (ideal < s.minPrice - 1e-9) {
        s.boundLocked = true;
        s.boundPrice = s.minPrice;
        s.idealPrice = s.minPrice;
        poolBudget = roundTo2(poolBudget - s.minPrice * s.quantity);
        anyViolated = true;
      } else if (ideal > s.maxPrice + 1e-9) {
        s.boundLocked = true;
        s.boundPrice = s.maxPrice;
        s.idealPrice = s.maxPrice;
        poolBudget = roundTo2(poolBudget - s.maxPrice * s.quantity);
        anyViolated = true;
      } else {
        s.idealPrice = ideal;
      }
    }

    if (!anyViolated) break;
  }

  // 5. 步长整数步换算 + 最大余额分配
  const invStep = stepToMultiplier(step);
  let baseStepsWeightedSum = 0;

  for (const s of slots) {
    const floatUnits = Math.max(0, s.idealPrice * invStep);
    let baseUnits = Math.floor(floatUnits + 1e-9);
    if (baseUnits < s.minUnits) baseUnits = s.minUnits;
    if (baseUnits > s.maxUnits) baseUnits = s.maxUnits;
    s.units = baseUnits;
    s.remainder = floatUnits - baseUnits;
    baseStepsWeightedSum += s.units * s.quantity;
  }

  // Target remaining budget expressed in integer step units (rounded to nearest step)
  const targetRemainingSteps = Math.round(remainingBudget * invStep);
  let diffSteps = targetRemainingSteps - baseStepsWeightedSum;

  const allSingleQty = slots.every((s) => s.quantity === 1);

  if (allSingleQty) {
    if (diffSteps > 0) {
      // 按余数降序，余数相同按权重降序，优先给可增加项 +1 步
      const candidates = [...slots].sort((a, b) => {
        if (Math.abs(b.remainder - a.remainder) > 1e-9) return b.remainder - a.remainder;
        return b.weight - a.weight;
      });
      let guard = 0;
      while (diffSteps > 0 && guard < diffSteps + slots.length * 4) {
        guard++;
        let progressed = false;
        for (const c of candidates) {
          if (diffSteps <= 0) break;
          if (c.units < c.maxUnits) {
            c.units += 1;
            diffSteps -= 1;
            progressed = true;
          }
        }
        if (!progressed) break;
      }
    } else if (diffSteps < 0) {
      // 超出时按余数升序、权重升序扣减
      const candidates = [...slots].sort((a, b) => {
        if (Math.abs(a.remainder - b.remainder) > 1e-9) return a.remainder - b.remainder;
        return a.weight - b.weight;
      });
      let guard = 0;
      while (diffSteps < 0 && guard < Math.abs(diffSteps) + slots.length * 4) {
        guard++;
        let progressed = false;
        for (const c of candidates) {
          if (diffSteps >= 0) break;
          if (c.units > c.minUnits) {
            c.units -= 1;
            diffSteps += 1;
            progressed = true;
          }
        }
        if (!progressed) break;
      }
    }
  } else {
    // 存在 Q_i > 1（盲抽二调场景）：尽量最小化 |diffSteps|，绝不死循环
    // 先尝试单轮最大余额顺次分配，再迭代寻找严格减小 |diffSteps| 的最优调整
    const maxIterations = Math.max(32, Math.abs(diffSteps) + slots.length * 6);
    for (let iter = 0; iter < maxIterations && diffSteps !== 0; iter++) {
      let bestSlot: InternalSlot | null = null;
      let bestDeltaDir: 1 | -1 = 1;
      let bestNewAbsDiff = Math.abs(diffSteps);
      let bestScore = -Infinity;

      for (const s of slots) {
        // 尝试 +1 步
        if (s.units < s.maxUnits) {
          const newDiff = diffSteps - s.quantity;
          const newAbs = Math.abs(newDiff);
          if (newAbs < bestNewAbsDiff || (newAbs === bestNewAbsDiff && newAbs < Math.abs(diffSteps))) {
            const score = s.remainder * 10 + s.weight;
            if (newAbs < bestNewAbsDiff || score > bestScore) {
              bestNewAbsDiff = newAbs;
              bestSlot = s;
              bestDeltaDir = 1;
              bestScore = score;
            }
          }
        }
        // 尝试 -1 步
        if (s.units > s.minUnits) {
          const newDiff = diffSteps + s.quantity;
          const newAbs = Math.abs(newDiff);
          if (newAbs < bestNewAbsDiff || (newAbs === bestNewAbsDiff && newAbs < Math.abs(diffSteps))) {
            const score = -s.remainder * 10 - s.weight;
            if (newAbs < bestNewAbsDiff || score > bestScore) {
              bestNewAbsDiff = newAbs;
              bestSlot = s;
              bestDeltaDir = -1;
              bestScore = score;
            }
          }
        }
      }

      if (!bestSlot) break;
      bestSlot.units += bestDeltaDir;
      diffSteps -= bestDeltaDir * bestSlot.quantity;
    }
  }

  // 回写计算出的单价
  for (const s of slots) {
    items[s.index].price = roundTo2(s.units * step);
  }

  const actualTotal = roundTo2(
    items.reduce((sum, item) => sum + (item.quantity > 0 ? item.price * item.quantity : 0), 0)
  );
  const residual = roundTo2(actualTotal - targetTotal);

  let status: RebalanceStatus = 'OK';
  if (Math.abs(residual) >= 0.005) {
    status = 'RESIDUAL_NONZERO';
  }

  return {
    items,
    targetTotal,
    actualTotal,
    residual,
    status,
    exceedAmount: 0,
  };
}

/**
 * 盲抽二调退补计算与群公告生成（纯函数）
 */
export function calcSecondarySettlement(
  items: GoodItem[],
  projectTitle = '本团'
): SecondarySettlementResult {
  const avgPrice = calcEffectiveAvgPrice(items);
  const rows: SettlementRow[] = [];
  const zeroQtyLabels: string[] = [];

  let totalPrepaid = 0;
  let totalFinal = 0;

  for (const item of items) {
    if (item.quantity <= 0) {
      zeroQtyLabels.push(item.label || '未命名');
      continue;
    }
    const prepaid = roundTo2(
      item.prepaidPrice !== undefined && Number.isFinite(item.prepaidPrice)
        ? Math.max(0, item.prepaidPrice)
        : avgPrice
    );
    const finalPrice = roundTo2(Math.max(0, item.price));
    const deltaPerItem = roundTo2(finalPrice - prepaid);
    const subtotalDelta = roundTo2(deltaPerItem * item.quantity);

    totalPrepaid = roundTo2(totalPrepaid + prepaid * item.quantity);
    totalFinal = roundTo2(totalFinal + finalPrice * item.quantity);

    rows.push({
      itemId: item.id,
      label: item.label || '未命名',
      quantity: item.quantity,
      prepaidPrice: prepaid,
      finalPrice,
      deltaPerItem,
      subtotalDelta,
    });
  }

  const totalDelta = roundTo2(totalFinal - totalPrepaid);

  const lines: string[] = [];
  lines.push(`【${projectTitle} · 盲抽配比二调结算单】`);
  lines.push(`有效出货：${rows.reduce((s, r) => s + r.quantity, 0)} 件 · 均价参考：¥${formatMoney(avgPrice)}`);
  lines.push('------------------------');
  for (const r of rows) {
    const action =
      r.deltaPerItem > 0
        ? `需补 ¥${formatMoney(r.deltaPerItem)}/件${r.quantity > 1 ? `（共补 ¥${formatMoney(r.subtotalDelta)}）` : ''}`
        : r.deltaPerItem < 0
          ? `应退 ¥${formatMoney(Math.abs(r.deltaPerItem))}/件${r.quantity > 1 ? `（共退 ¥${formatMoney(Math.abs(r.subtotalDelta))}）` : ''}`
          : '不退不补';
    lines.push(
      `${r.label} ×${r.quantity}：原预收 ¥${formatMoney(r.prepaidPrice)} → 现价 ¥${formatMoney(r.finalPrice)}（${action}）`
    );
  }
  if (zeroQtyLabels.length > 0) {
    lines.push(`未出货角色：${zeroQtyLabels.join('、')}（全额退还预收）`);
  }
  lines.push('------------------------');
  const netLabel =
    totalDelta > 0
      ? `总净补差 +¥${formatMoney(totalDelta)}`
      : totalDelta < 0
        ? `总净退差 -¥${formatMoney(Math.abs(totalDelta))}`
        : '预收与二调总额持平';
  lines.push(
    `总账校验：原预收合计 ¥${formatMoney(totalPrepaid)} ｜ 二调合计 ¥${formatMoney(totalFinal)} ｜ ${netLabel}`
  );

  return {
    avgPrice,
    rows,
    zeroQtyLabels,
    totalPrepaid,
    totalFinal,
    totalDelta,
    announcementText: lines.join('\n'),
  };
}
