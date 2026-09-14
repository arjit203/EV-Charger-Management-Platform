/**
 * The CMS navigation model — one definition, grouped, filtered by role.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE SIDEBAR. Before Module 15 the navigation was a flat
 * `ROLE_LINKS` array inside `app/dashboard/page.tsx` that fourteen modules had each appended a
 * line to. It worked, and it had no structure: eleven equal-weight buttons with no grouping and
 * no way to say "this belongs to Billing". Pulling it into a grouped model is the whole reason
 * the sidebar can look like an operations console instead of a link dump.
 *
 * ============================================================================
 * HIDING A MENU ITEM IS NOT SECURITY.
 *
 * Every route below is enforced server-side — `authenticate`, `authorize(...)`,
 * `requireActiveCompany`, and a company-scoped query inside the service. A user who
 * types a URL they are not entitled to gets a 403 from the API, not a blank page.
 * This file exists so the UI does not offer people doors that will not open.
 * ============================================================================
 */

import type { Role } from '@/types/api';

export interface NavItem {
  href: string;
  label: string;
  /** Which roles are offered this. The backend decides who may actually use it. */
  roles: Role[];
}

export interface NavGroup {
  /** Null for the top-level entry that sits above the groups. */
  title: string | null;
  items: NavItem[];
}

const STAFF: Role[] = ['super_admin', 'cpo_admin', 'operator'];
const ADMINS: Role[] = ['super_admin', 'cpo_admin'];

/**
 * The groups, in the order they appear.
 *
 * `Operations` first because this is an operations console: what is happening now matters more
 * on a day-to-day basis than who the users are. `Billing` is absent for operators entirely —
 * the same boundary Module 13 drew when it made `/analytics/revenue` a 403 for them.
 */
const GROUPS: NavGroup[] = [
  {
    title: null,
    items: [{ href: '/dashboard', label: 'Dashboard', roles: STAFF }],
  },
  {
    title: 'Operations',
    items: [
      { href: '/monitor', label: 'Live operations', roles: STAFF },
      { href: '/sessions', label: 'Charging sessions', roles: STAFF },
      { href: '/stations', label: 'Stations', roles: STAFF },
      { href: '/chargers', label: 'Chargers', roles: STAFF },
      { href: '/map', label: 'Station map', roles: STAFF },
    ],
  },
  {
    title: 'Management',
    items: [
      /*
       * super_admin manages every company; a cpo_admin and an operator have exactly one, and
       * Module 2 gave them a different route for it. Two entries, one slot — never both.
       */
      { href: '/companies', label: 'Companies', roles: ['super_admin'] },
      { href: '/my-company', label: 'My company', roles: ['cpo_admin', 'operator'] },
      { href: '/users', label: 'Users', roles: ADMINS },
      { href: '/tariffs', label: 'Tariffs', roles: STAFF },
      { href: '/complaints', label: 'Support', roles: STAFF },
    ],
  },
  {
    /* Money. Absent for an operator, matching Module 13's revenue boundary exactly. */
    title: 'Billing',
    items: [{ href: '/payments', label: 'Payments', roles: ADMINS }],
  },
  {
    title: 'Insights',
    items: [
      { href: '/analytics', label: 'Analytics', roles: STAFF },
      { href: '/notifications', label: 'Notifications', roles: STAFF },
    ],
  },
];

/** The groups this role is offered, with empty groups dropped rather than rendered bare. */
export function navigationFor(role: Role): NavGroup[] {
  return GROUPS.map((group) => ({
    title: group.title,
    items: group.items.filter((item) => item.roles.includes(role)),
  })).filter((group) => group.items.length > 0);
}

/**
 * The page title for the topbar, from the current path.
 *
 * Longest match wins, so `/stations/new` resolves to "Stations" rather than failing over to the
 * root. Detail routes inherit their section's name, which is what a breadcrumb-less topbar wants.
 */
const TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/monitor': 'Live operations',
  '/sessions': 'Charging sessions',
  '/stations': 'Stations',
  '/chargers': 'Chargers',
  '/map': 'Station map',
  '/companies': 'Companies',
  '/my-company': 'My company',
  '/users': 'Users',
  '/tariffs': 'Tariffs',
  '/complaints': 'Support',
  '/payments': 'Payments',
  '/wallet': 'Wallet',
  '/analytics': 'Analytics',
  '/notifications': 'Notifications',
  '/profile': 'My profile',
  '/my-vehicles': 'My vehicles',
  '/charge': 'Start charging',
};

export function titleForPath(pathname: string): string {
  const match = Object.keys(TITLES)
    .filter((path) => pathname === path || pathname.startsWith(`${path}/`))
    .sort((a, b) => b.length - a.length)[0];

  return match ? TITLES[match] : 'EV-CMS';
}

/** Is this nav item the current page? Section entries stay highlighted on their detail routes. */
export function isActivePath(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
