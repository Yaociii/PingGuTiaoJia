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

export interface DatabaseSchema {
  nextStatId: number;
  nextContributionId: number;
  nextLogId: number;
  invite_codes: Record<string, InviteCodeRecord>;
  character_market_stats: CharacterMarketStatRecord[];
  market_contributions: MarketContributionRecord[];
  detect_logs: DetectLogRecord[];
}

export interface RawVlmItem {
  label?: unknown;
  box?: unknown;
  weight?: unknown;
}

export interface NormalizedVlmItem {
  label: string;
  box: [number, number, number, number];
  x: number;
  y: number;
  weight: number;
}

export interface ParsedVlmResponse {
  ip_name: string;
  items: NormalizedVlmItem[];
}
