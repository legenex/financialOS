import { NavLink, useLocation, useSearchParams } from 'react-router';
import { withContext } from '../../lib/context';
import { PRIMARY, isActive } from './nav';

export function BottomTabs() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  return (
    <nav className="fos-tabbar" aria-label="Primary">
      <ul className="fos-tabbar__list">
        {PRIMARY.map((d) => {
          const Icon = d.icon;
          const active = isActive(pathname, d.path);
          return (
            <li key={d.id}>
              <NavLink to={withContext(d.path, params)} className="fos-tab" aria-current={active ? 'page' : undefined}>
                <span className="fos-tab__icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={active ? 2.25 : 1.9} />
                </span>
                <span>{d.label}</span>
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
