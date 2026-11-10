import { createContext, useContext, useState } from 'react';

// Shares the course + currently-viewed module with the global AI assistant so
// it can ground answers on the exact module the learner is reading.
const Ctx = createContext(null);

export function CourseScopeProvider({ children }) {
  const [scope, setScope] = useState({ courseId: null, moduleId: null });
  return <Ctx.Provider value={{ scope, setScope }}>{children}</Ctx.Provider>;
}

export const useCourseScope = () => useContext(Ctx) || { scope: { courseId: null, moduleId: null }, setScope: () => {} };
