import { Navigate, type RouteObject } from 'react-router';
import { PrivateLayout } from './PrivateLayout';
import { PublicLayout } from './PublicLayout';
import { RootLayout } from './RootLayout';
import { RouteError } from './RouteError';

/**
 * Route table. Feature screens are lazy-loaded route modules; each exports `Component`.
 * Stub areas (money, business, connections, imports, settings, system) are owned by the feature agent and
 * receive every sub-path via `/*`.
 */
export const routes: RouteObject[] = [
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      {
        element: <PublicLayout />,
        children: [
          { path: 'setup', lazy: () => import('../features/setup/SetupPage') },
          { path: 'login', lazy: () => import('../features/auth/LoginPage') },
          { path: 'locked', lazy: () => import('../features/auth/LockedPage') },
        ],
      },
      {
        element: <PrivateLayout />,
        children: [
          { index: true, element: <Navigate to="/today" replace /> },
          { path: 'today', lazy: () => import('../features/today/TodayPage') },
          { path: 'plan/:tab?', lazy: () => import('../features/plan/PlanPage') },
          { path: 'coach/:tab?', lazy: () => import('../features/coach/CoachPage') },
          { path: 'inbox', lazy: () => import('../features/inbox/InboxPage') },
          { path: 'money/*', lazy: () => import('../features/money/index') },
          { path: 'business/*', lazy: () => import('../features/business/index') },
          { path: 'connections/*', lazy: () => import('../features/connections/index') },
          { path: 'imports/*', lazy: () => import('../features/imports/index') },
          { path: 'settings/*', lazy: () => import('../features/settings/index') },
          { path: 'system/*', lazy: () => import('../features/system/index') },
          { path: '*', lazy: () => import('../features/notfound/NotFoundPage') },
        ],
      },
    ],
  },
];
