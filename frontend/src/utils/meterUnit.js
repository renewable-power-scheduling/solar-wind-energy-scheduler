export const isGsnpPlant = (...values) =>
  values.some((value) => {
    const text = String(value || '').toLowerCase();
    return text.includes('gsnp') || text.includes('globus steel');
  });

const compactMeterHeader = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/[^a-z0-9]+/g, '');

export const findGsnpTvmActivePowerIndex = (headers = [], context = {}) => {
  if (!isGsnpPlant(context?.plantCode, context?.plantName, context?.sourceKey)) return -1;
  return (headers || []).findIndex((header) => {
    const compact = compactMeterHeader(header);
    return compact.includes('tvm') && compact.includes('activepower');
  });
};

export const resolveMeterMwFactor = ({
  plantCode,
  plantName,
  sourceKey,
  explicitKw = false,
  explicitMw = false,
  averageValue = 0,
} = {}) => {
  if (isGsnpPlant(plantCode, plantName, sourceKey)) return 1 / 1000;
  return explicitKw || (!explicitMw && Number(averageValue) > 200) ? 1 / 1000 : 1;
};
