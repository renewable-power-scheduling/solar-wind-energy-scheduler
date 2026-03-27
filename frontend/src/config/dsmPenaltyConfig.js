export const DSM_PENALTY_CONFIG_BY_STATE = {
  Telangana: {
    state: 'Telangana',
    byType: {
      Solar: {
        baseBand: 15,
        bands: [
          { min: 0, max: 15, rate: 0 },
          { min: 15, max: 25, rate: 0.5 },
          { min: 25, max: 35, rate: 1.0 },
          { min: 35, max: Infinity, rate: 1.5 },
        ],
      },
      Wind: {
        baseBand: 15,
        bands: [
          { min: 0, max: 15, rate: 0 },
          { min: 15, max: 25, rate: 0.5 },
          { min: 25, max: 35, rate: 1.0 },
          { min: 35, max: Infinity, rate: 1.5 },
        ],
      },
    },
  },
  Maharashtra: {
    state: 'Maharashtra',
    byType: {
      Solar: {
        baseBand: 10,
        bands: [
          { min: 0, max: 10, rate: 0 },
          { min: 10, max: 12, rate: 0.25 },
          { min: 12, max: 15, rate: 0.5 },
          { min: 15, max: 25, rate: 0.75 },
          { min: 25, max: Infinity, rate: 1.0 },
        ],
      },
      Wind: {
        baseBand: 12,
        bands: [
          { min: 0, max: 12, rate: 0 },
          { min: 12, max: 15, rate: 0.25 },
          { min: 15, max: 20, rate: 0.5 },
          { min: 20, max: Infinity, rate: 1.0 },
        ],
      },
    },
  },
  'Madhya Pradesh': {
    state: 'Madhya Pradesh',
    byType: {
      Solar: {
        baseBand: 10,
        bands: [
          { min: 0, max: 10, rate: 0 },
          { min: 10, max: 15, rate: 0.5 },
          { min: 15, max: 20, rate: 0.75 },
          { min: 20, max: Infinity, rate: 1.0 },
        ],
      },
      Wind: {
        baseBand: 15,
        bands: [
          { min: 0, max: 15, rate: 0 },
          { min: 15, max: 20, rate: 0.5 },
          { min: 20, max: 25, rate: 0.75 },
          { min: 25, max: Infinity, rate: 1.0 },
        ],
      },
    },
  },
};

export const DEFAULT_DSM_PENALTY_CONFIG = {
  state: 'Default',
  byType: {
    Solar: {
      baseBand: 10,
      bands: [
        { min: 0, max: 10, rate: 0 },
        { min: 10, max: 12, rate: 0.25 },
        { min: 12, max: 15, rate: 0.5 },
        { min: 15, max: 25, rate: 0.75 },
        { min: 25, max: Infinity, rate: 1.0 },
      ],
    },
    Wind: {
      baseBand: 12,
      bands: [
        { min: 0, max: 12, rate: 0 },
        { min: 12, max: 15, rate: 0.25 },
        { min: 15, max: 20, rate: 0.5 },
        { min: 20, max: Infinity, rate: 1.0 },
      ],
    },
  },
};
