const PPA_RATE_FALLBACK_RS_PER_KWH = Object.freeze({
  SIRMOUR: 2.94,
});

export const getPpaRateRsPerKwh = ({ siteCode, siteConfig } = {}) => {
  const normalizedSite = String(siteCode || '').trim().toUpperCase();
  const cfg = siteConfig || {};

  const candidates = [
    cfg.ppaRate,
    cfg.ppa_rate,
    cfg.tariff,
    cfg.tariffRsPerKwh,
    cfg.rateRsPerKwh,
  ];

  for (const v of candidates) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  const fallback = Number(PPA_RATE_FALLBACK_RS_PER_KWH[normalizedSite]);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null;
};

