import { createContext, useContext } from 'react';

export const FilterContext = createContext();
export const DataContext = createContext();
export const ThemeContext = createContext();
export const AuthContext = createContext();
export const WorkflowGuideContext = createContext();

export function useFilters() {
  return useContext(FilterContext);
}

export function useData() {
  return useContext(DataContext);
}

export function useTheme() {
  return useContext(ThemeContext);
}

export function useAuth() {
  return useContext(AuthContext);
}

export function useWorkflowGuide() {
  return useContext(WorkflowGuideContext);
}

