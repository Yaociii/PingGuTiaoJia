import type { GachaProject, GachaProjectMeta, ProjectSummary } from '../types/pricing';
import { calcTargetTotal } from './rebalancer';

const DB_NAME = 'gacha_pricer_workspace_v1';
const DB_VERSION = 1;
const META_STORE = 'projects_meta';
const IMAGE_STORE = 'projects_images';

// In-memory fallback if IndexedDB is unavailable in restricted contexts
const memoryMeta = new Map<string, GachaProjectMeta>();
const memoryImages = new Map<string, string>();

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(IMAGE_STORE)) {
          db.createObjectStore(IMAGE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function toProjectSummary(meta: GachaProjectMeta): ProjectSummary {
  return {
    id: meta.id,
    name: meta.name,
    ipName: meta.ipName,
    category: meta.category,
    updatedAt: meta.updatedAt,
    itemCount: meta.items.length,
    targetTotal: calcTargetTotal(meta.cost),
    thumbDataUrl: meta.thumbDataUrl,
  };
}

/**
 * 元图分离存储：将 GachaProjectMeta 与高清 imageDataUrl 分表保存
 */
export async function saveProjectToStorage(project: GachaProject): Promise<ProjectSummary> {
  const { imageDataUrl, ...meta } = project;
  memoryMeta.set(meta.id, meta);
  memoryImages.set(meta.id, imageDataUrl);

  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([META_STORE, IMAGE_STORE], 'readwrite');
        tx.objectStore(META_STORE).put(meta);
        tx.objectStore(IMAGE_STORE).put({ id: meta.id, imageDataUrl });
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  return toProjectSummary(meta);
}

/**
 * 仅扫描 meta 表，快速列出所有历史工程摘要（按 updatedAt 降序）
 */
export async function listProjectSummaries(): Promise<ProjectSummary[]> {
  const db = await openDb();
  let metas: GachaProjectMeta[] = [];

  if (db) {
    metas = await new Promise<GachaProjectMeta[]>((resolve) => {
      try {
        const tx = db.transaction(META_STORE, 'readonly');
        const req = tx.objectStore(META_STORE).getAll();
        req.onsuccess = () => resolve((req.result as GachaProjectMeta[]) || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  } else {
    metas = Array.from(memoryMeta.values());
  }

  return metas
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(toProjectSummary);
}

export async function loadProjectFromStorage(projectId: string): Promise<GachaProject | null> {
  const db = await openDb();
  if (db) {
    const result = await new Promise<GachaProject | null>((resolve) => {
      try {
        const tx = db.transaction([META_STORE, IMAGE_STORE], 'readonly');
        const metaReq = tx.objectStore(META_STORE).get(projectId);
        const imgReq = tx.objectStore(IMAGE_STORE).get(projectId);
        let meta: GachaProjectMeta | undefined;
        let imgRecord: { id: string; imageDataUrl: string } | undefined;

        metaReq.onsuccess = () => {
          meta = metaReq.result as GachaProjectMeta | undefined;
        };
        imgReq.onsuccess = () => {
          imgRecord = imgReq.result as { id: string; imageDataUrl: string } | undefined;
        };
        tx.oncomplete = () => {
          if (!meta) {
            resolve(null);
            return;
          }
          resolve({
            ...meta,
            imageDataUrl: imgRecord?.imageDataUrl || '',
          });
        };
        tx.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    if (result) return result;
  }

  const memMeta = memoryMeta.get(projectId);
  if (!memMeta) return null;
  return {
    ...memMeta,
    imageDataUrl: memoryImages.get(projectId) || '',
  };
}

export async function deleteProjectFromStorage(projectId: string): Promise<boolean> {
  memoryMeta.delete(projectId);
  memoryImages.delete(projectId);

  const db = await openDb();
  if (db) {
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction([META_STORE, IMAGE_STORE], 'readwrite');
        tx.objectStore(META_STORE).delete(projectId);
        tx.objectStore(IMAGE_STORE).delete(projectId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  return true;
}
