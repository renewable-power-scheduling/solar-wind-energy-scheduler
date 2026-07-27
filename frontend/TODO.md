# Employee ID → Name Replacement - Implementation TODO

Current working directory: `c:/Users/harsh/Downloads/QCA DASHBOARD FINAL (2)/QCA DASHBOARD FINAL`

## Plan Breakdown & Progress Tracker

### ✅ 1. Create Centralized Employee Mapping
- ✅ **Created** `src/constants/employeeMap.js` 
  - Extracted exact data from Login.jsx TEAM_ACCOUNTS + ADMIN_ACCOUNT
  - Exported `EMPLOYEE_NAME_MAP` object

### ✅ 2. Create Helper Function 
- ✅ **Created** `src/utils/getEmployeeName.js`
  - Imported map, exported `getEmployeeName(id)` with fallback logic

### ✅ 3. Update TopNav User Display (2 locations)
- ✅ **Edited** `src/app/components/TopNav.jsx`
  - Replaced raw `user?.username || user?.empId` → `getEmployeeName(...)` (2 instances)
  - Added import statement

### ✅ 4. Update ScheduleReadinessDashboard Uploads
- ✅ **Edited** `src/app/components/screens/ScheduleReadinessDashboard.jsx`
  - In `executeAction()` → `uploadConfirmedTemplate`: `requested_by: getEmployeeName(currentUser?.empId)`
  - Added imports + useAuth hook

### ✅ 5. Update ScheduleTemplates Uploads
- ✅ **Edited** `src/app/components/screens/ScheduleTemplates.jsx`
  - In `handleConfirmUploaded()` → `uploadConfirmedTemplate`: `requested_by: getEmployeeName(currentUser?.empId)`  
  - Added imports for helper + AuthContext hook

### ✅ 6. Verify & Test
- ✅ Run `npm run dev`
- ✅ Login as VPPL6127 → TopNav shows "Pooja Patil"
- ✅ Test uploads → API sends name (backend stores string)
- ✅ No regressions in Login/TopNav display

### ✅ 7. Completion
- ✅ **attempt_completion** with results summary + demo command

**Progress:** 7/7 complete ✅  
**Status:** Employee name replacement fully implemented across UI + API payloads**

