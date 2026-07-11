const ADMIN_ACCOUNT = {
  username: 'Scheduling_VPPL',
  name: 'Scheduling Admin',
};

const INTERN_ACCOUNT = {
  empId: 'INTERN',
  name: 'Intern',
};

const TEAM_ACCOUNTS = [
  { empId: 'VPPL6127', name: 'Pooja Patil' },
  { empId: 'VPPL6131', name: 'Dhiraj Ganvir' },
  { empId: 'VPPL6125', name: 'Kaustubh Shah' },
  { empId: 'VPPL6128', name: 'Shraddha Thakre' },
  { empId: 'VPPL6123', name: 'Ashish Jha' },
  { empId: 'VPPL6124', name: 'Aditya Kamble' },
  { empId: 'VPPL6126', name: 'Ashwini Malkar' },
  { empId: 'VPPL6136', name: 'Vinayak Kariyattina' },
  { empId: 'VPPL6137', name: 'Prabhat Gupta' },
];

export const EMPLOYEE_NAME_MAP = Object.fromEntries([
  ...TEAM_ACCOUNTS.map(({ empId, name }) => [empId, name]),
  [INTERN_ACCOUNT.empId, INTERN_ACCOUNT.name],
  [ADMIN_ACCOUNT.username, ADMIN_ACCOUNT.name],
]);
