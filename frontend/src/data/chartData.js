import { generateTimeSlots } from "./timeUtils";

const slots = generateTimeSlots();

export const forecastData = slots.map(() =>
  Math.floor(Math.random() * 80 + 20)
);

export const actualData = slots.map(() =>
  Math.floor(Math.random() * 80 + 20)
);

export const timeLabels = slots;
