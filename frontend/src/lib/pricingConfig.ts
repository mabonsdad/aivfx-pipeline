export type PricingBillingUnit =
  | "per_1m_tokens"
  | "per_image"
  | "per_second"
  | "per_million_pixels"
  | "provider_example"
  | "mixed";

export type PricingConfigEntry = {
  pricingId: string;
  label: string;
  provider: string;
  appModelId?: string | null;
  providerModel?: string | null;
  category?: string | null;
  billingUnit: PricingBillingUnit;
  rates: Record<string, number | null>;
  assumptions?: string | null;
  sourceUrl?: string | null;
  sourceCheckedAt?: string | null;
  notes?: string | null;
};

export type PricingAdminConfig = {
  schemaVersion: number;
  entries: PricingConfigEntry[];
  updatedAt?: string | null;
  updatedBy?: string | null;
};
