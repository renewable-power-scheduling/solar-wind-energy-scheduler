import { EMPLOYEE_NAME_MAP } from '../constants/employeeMap.js';

export const getEmployeeName = (id) => {
  if (id === undefined || id === null) return 'Unknown';
  const raw = String(id).trim();
  if (!raw) return 'Unknown';

  if (raw.toLowerCase() === 'admin') return 'Scheduling Admin';

  if (Object.prototype.hasOwnProperty.call(EMPLOYEE_NAME_MAP, raw)) {
    return EMPLOYEE_NAME_MAP[raw];
  }

  const matchKey = Object.keys(EMPLOYEE_NAME_MAP).find(
    (key) => key.toLowerCase() === raw.toLowerCase()
  );
  if (matchKey) return EMPLOYEE_NAME_MAP[matchKey];

  return raw;
};
