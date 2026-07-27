export const isGsnpPlant = (...values) =>
  values.some((value) => {
    const text = String(value || '').toLowerCase();
    return text.includes('gsnp') || text.includes('globus steel');
  });

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
