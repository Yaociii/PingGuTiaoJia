export type PricingTier = 'exact_market' | 'char_market' | 'local_db' | 'vlm_fallback';
export type PriceFreshness = 'fresh' | 'recent' | 'stale';
export type GroupOrderStatus = 'open' | 'locked' | 'settled';

export interface InviteCodeRecord {
  code: string;
  owner_note: string;
  daily_limit: number;
  used_today: number;
  last_reset_date: string; // YYYY-MM-DD (UTC)
  is_active: boolean;
  created_at: string;
}

export interface CharacterMarketStatRecord {
  id: number;
  ip_name: string;
  character_name: string;
  normalized_key: string;
  category: string;
  avg_weight_ratio: number;
  sample_count: number;
  updated_at: string;
}

export interface MarketPriceSourceRecord {
  platform: string;
  title: string;
  raw_price: number;
  currency: 'CNY' | 'JPY';
  cny_price: number;
  listed_at: string; // YYYY-MM-DD or ISO
  url?: string;
  freshness: PriceFreshness;
  sold?: boolean;
}

export interface MarketPriceCacheRecord {
  cache_key: string;
  ip_name: string;
  normalized_char: string;
  series_key: string;
  item_type: string;
  market_price_median: number | null;
  market_price_range: [number, number] | null;
  sample_count: number;
  sources: MarketPriceSourceRecord[];
  pricing_tier: PricingTier;
  freshness: PriceFreshness;
  query_used: string;
  cached_at: string;
  expires_at: string;
}

export interface MarketContributionRecord {
  id: number;
  token_code: string;
  project_id: string;
  ip_name: string;
  item_count: number;
  created_at: string;
}

export interface DetectLogRecord {
  id: number;
  token_code: string;
  provider: string;
  model: string;
  detected_count: number;
  latency_ms: number;
  status: 'ok' | 'error';
  error_msg: string | null;
  created_at: string;
}

export interface GroupOrderRecord {
  id: string;
  share_code: string;
  title: string;
  ip_name: string;
  owner_token: string;
  annotated_image_data_url: string;
  status: GroupOrderStatus;
  created_at: string;
  updated_at: string;
}

export interface GroupOrderItemRecord {
  id: string;
  order_id: string;
  source_item_id?: string;
  label: string;
  price: number;
  prepaid_price?: number;
  total_qty: number;
  claimed_qty: number;
  tag: string;
  box_json?: string;
}

export interface GroupClaimRecord {
  id: string;
  order_id: string;
  item_id: string;
  buyer_name: string;
  buyer_contact: string;
  qty: number;
  claim_token: string;
  status: 'active' | 'cancelled';
  created_at: string;
}

export interface DatabaseSchema {
  nextStatId: number;
  nextContributionId: number;
  nextLogId: number;
  invite_codes: Record<string, InviteCodeRecord>;
  character_market_stats: CharacterMarketStatRecord[];
  market_price_cache: Record<string, MarketPriceCacheRecord>;
  market_contributions: MarketContributionRecord[];
  detect_logs: DetectLogRecord[];
  group_orders: Record<string, GroupOrderRecord>;
  group_order_items: GroupOrderItemRecord[];
  group_claims: GroupClaimRecord[];
}

export interface RawVlmItem {
  label?: unknown;
  series_hint?: unknown;
  item_type?: unknown;
  jp_keywords?: unknown;
  box?: unknown;
  weight?: unknown;
}

export interface NormalizedVlmItem {
  label: string;
  series_hint: string;
  item_type: string;
  jp_keywords: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
}

export interface ParsedVlmResponse {
  ip_name: string;
  series_hint: string;
  items: NormalizedVlmItem[];
}
