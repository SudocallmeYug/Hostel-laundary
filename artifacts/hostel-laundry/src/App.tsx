import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QRCodeSVG } from 'qrcode.react';
import { BrowserQRCodeReader } from '@zxing/browser';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Activity, ArrowDownLeft, ArrowRight, BadgeCheck, CalendarDays, Camera, CameraOff,
  Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Copy,
  DoorOpen, Droplets, ExternalLink, Gauge, House, KeyRound, LoaderCircle, LogOut,
  Menu, ScanLine, ShieldCheck, Shirt, Sparkles, TicketCheck, UserRound, Users,
  WashingMachine, X,
} from 'lucide-react';

import {
  useHealthCheck, useGetLaundryMe, getGetLaundryMeQueryKey,
  useGetLaundryDashboard, getGetLaundryDashboardQueryKey, useGetLaundrySlots,
  getGetLaundrySlotsQueryKey, useGetLaundryBookings, getGetLaundryBookingsQueryKey,
  useCreateLaundryBooking, useCancelLaundryBooking, useGetLaundryDuties,
  getGetLaundryDutiesQueryKey, useGetLaundryQrCodes, getGetLaundryQrCodesQueryKey,
  useVerifyLaundryQr, useCompleteLaundryHandover, useGetManagementOverview,
  getGetManagementOverviewQueryKey, useUpdateLaundryMe,
} from '@workspace/api-client-react';
import type { LaundryBooking, LaundrySlot, DutyAssignment, QrCredential, QrVerificationResult } from '@workspace/api-client-react';
import { Link, Redirect, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const defaultClerkKey = 'pk_test_c3VwZXItZmxlYS01OTQzLmNsZXJrLmFjY291bnRzLmRldiQ';
const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || defaultClerkKey;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const stripBase = (path: string) => basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
const clerkAppearance = {
  theme: shadcn, cssLayerName: 'clerk',
  options: { logoPlacement: 'none' as const, logoLinkUrl: basePath || '/' },
  variables: {
    colorPrimary: '#287765', colorForeground: '#26363a', colorMutedForeground: '#687574',
    colorDanger: '#bb5149', colorBackground: '#fffaf1', colorInput: '#fffdf9',
    colorInputForeground: '#26363a', colorNeutral: '#dcd8cd', fontFamily: 'DM Sans',
    borderRadius: '1rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fffaf1] rounded-2xl w-[440px] max-w-full overflow-hidden shadow-none border border-[#e5dfd5]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none', footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#26363a] font-bold', headerSubtitle: 'text-[#687574]',
    socialButtonsBlockButtonText: 'text-[#26363a] font-semibold', formFieldLabel: 'text-[#26363a] font-semibold',
    footerActionLink: 'text-[#287765] font-semibold', footerActionText: 'text-[#687574]', dividerText: 'text-[#687574]',
    identityPreviewEditButton: 'text-[#287765]', formFieldSuccessText: 'text-[#287765]', alertText: 'text-[#26363a]',
    socialButtonsBlockButton: 'border-[#dcd8cd] rounded-xl',
    formButtonPrimary: 'bg-[#287765] hover:bg-[#205f53] rounded-xl', formFieldInput: 'rounded-xl border-[#dcd8cd] bg-[#fffdf9]',
    footerAction: 'text-[#687574]', dividerLine: 'bg-[#dedacf]', alert: 'rounded-xl',
    otpCodeFieldInput: 'rounded-lg', formFieldRow: 'gap-2', main: 'gap-5',
  },
};

function buzz(pattern: number | number[] = 12) {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(pattern);
}
const fmt = (date?: string | null, options?: Intl.DateTimeFormatOptions) => date
  ? new Intl.DateTimeFormat(undefined, options ?? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date))
  : 'Not scheduled';
const timeRange = (start?: string | null, end?: string | null) => start && end
  ? `${fmt(start, { hour: 'numeric', minute: '2-digit' })} – ${fmt(end, { hour: 'numeric', minute: '2-digit' })}`
  : 'Time to be confirmed';
const statusTone = (status: string) => status === 'completed' || status === 'active' ? 'good' : status === 'missed' || status === 'cancelled' ? 'bad' : 'neutral';

function Button({ children, className = '', onClick, type = 'button', disabled, testId, variant = 'primary' }: {
  children: ReactNode; className?: string; onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; testId: string; variant?: 'primary' | 'quiet' | 'outline' | 'danger';
}) {
  return <button type={type} data-testid={testId} disabled={disabled} onClick={onClick} className={`button button-${variant} focus-ring ${className}`}>
    {children}
  </button>;
}
function Panel({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) {
  return <section data-testid={testId} className={`panel ${className}`}>{children}</section>;
}
function Title({ eyebrow, children, aside }: { eyebrow: string; children: ReactNode; aside?: ReactNode }) {
  return <div className="title-row"><div><div className="eyebrow">{eyebrow}</div><h1 className="display page-title">{children}</h1></div>{aside}</div>;
}
function Loading({ label = 'Loading your laundry space' }: { label?: string }) {
  return <div className="loading-block" role="status"><div className="skeleton skeleton-line wide"/><div className="skeleton skeleton-card"/><div className="skeleton skeleton-line"/><span>{label}</span></div>;
}
function QueryError({ retry }: { retry: () => void }) {
  return <Panel className="message-panel" testId="status-load-error"><div className="message-mark"><Activity size={19}/></div><div><strong>Couldn’t load this view</strong><p>Give it another moment, then try again.</p></div><Button variant="outline" testId="button-retry" onClick={retry}>Retry</Button></Panel>;
}
function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Shirt size={21}/></span><strong>{title}</strong><p>{detail}</p>{action}</div>;
}
function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`} data-testid="status-badge">{children}</span>;
}

const navItems = [
  { href: '/user-portal', label: 'Overview', icon: House },
  { href: '/book', label: 'Book a slot', icon: CalendarDays },
  { href: '/bookings', label: 'My bookings', icon: TicketCheck },
  { href: '/duties', label: 'Duty rota', icon: ShieldCheck },
  { href: '/qr-codes', label: 'Credentials', icon: ScanLine },
  { href: '/scan', label: 'Verify token', icon: KeyRound },
  { href: '/handover', label: 'Handover', icon: ArrowDownLeft },
  { href: '/manager', label: 'Manager view', icon: Gauge },
  { href: '/profile', label: 'My profile', icon: UserRound },
];

function Shell({ children }: { children: ReactNode }) {
  const [path] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { signOut } = useClerk();
  const { user } = useUser();
  const initials = (user?.firstName?.[0] ?? 'S') + (user?.lastName?.[0] ?? '');
  return <div className="app-shell grain">
    <aside className="sidebar">
      <Link href="/user-portal" className="brand focus-ring" data-testid="link-brand"><span className="brand-mark"><Droplets size={18}/></span><span>WASH<span className="brand-light">ROOM</span><small>HOSTEL LAUNDRY</small></span></Link>
      <div className="sidebar-label">YOUR SPACE</div>
      <nav className="side-nav" aria-label="Main navigation">
        {navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`link-${href.slice(1)}`} className={`nav-link focus-ring ${path === href ? 'nav-active' : ''}`} onClick={() => setMenuOpen(false)}>
          <Icon size={17}/><span>{label}</span>{path === href && <span className="nav-dot"/>}
        </Link>)}
      </nav>
      <div className="sidebar-foot"><div className="mini-status"><span className="live-dot"/><span>Room access is in good order</span></div><button onClick={() => signOut({ redirectUrl: basePath || '/' })} className="logout-link focus-ring" data-testid="button-sign-out"><LogOut size={15}/> Sign out</button></div>
    </aside>
    <div className="main-column">
      <header className="topbar">
        <div className="mobile-brand"><span className="brand-mark"><Droplets size={16}/></span><b>WASHROOM</b></div>
        <div className="topbar-context"><span className="live-dot"/> Shared laundry · Fair access</div>
        <Link href="/profile" className="profile-chip focus-ring" data-testid="link-profile-header"><span className="avatar">{initials}</span><span className="profile-chip-name">{user?.firstName || 'My profile'}</span><ChevronDown size={13}/></Link>
        <button className="mobile-menu-button focus-ring" data-testid="button-open-menu" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? 'Close navigation' : 'Open navigation'}>{menuOpen ? <X size={20}/> : <Menu size={20}/>}</button>
      </header>
      {menuOpen && <div className="mobile-menu" data-testid="panel-mobile-navigation">{navItems.map(({ href, label, icon: Icon }) => <Link key={href} href={href} onClick={() => setMenuOpen(false)} className="mobile-menu-link" data-testid={`mobile-link-${href.slice(1)}`}><Icon size={17}/>{label}<ChevronRight size={15}/></Link>)}<button onClick={() => signOut({ redirectUrl: basePath || '/' })} className="mobile-menu-link"><LogOut size={17}/>Sign out</button></div>}
      <main className="content" key={path}><div className="page-enter">{children}</div></main>
      <footer className="mobile-nav">
        {navItems.slice(0, 5).map(({ href, label, icon: Icon }) => <Link key={href} href={href} data-testid={`bottom-link-${href.slice(1)}`} className={`mobile-nav-item ${path === href ? 'mobile-nav-active' : ''}`}><Icon size={18}/><span>{label === 'Overview' ? 'Home' : label === 'Book a slot' ? 'Book' : label === 'My bookings' ? 'Bookings' : label === 'Duty rota' ? 'Duty' : 'Codes'}</span></Link>)}
        <button className="mobile-nav-item" onClick={() => setMenuOpen(!menuOpen)} data-testid="button-bottom-more"><Menu size={18}/><span>More</span></button>
      </footer>
    </div>
  </div>;
}

function Home() {
  return <div className="welcome-page">
    <div className="welcome-top"><Link href="/" className="brand focus-ring" data-testid="link-brand-home"><span className="brand-mark"><Droplets size={18}/></span><span>WASH<span className="brand-light">ROOM</span><small>HOSTEL LAUNDRY</small></span></Link><Link href="/sign-in" className="welcome-login" data-testid="link-sign-in">Sign in <ArrowRight size={15}/></Link></div>
    <div className="welcome-content">
      <div className="welcome-copy"><div className="eyebrow"><span className="live-dot"/> THE SHARED ROOM, IN GOOD ORDER</div><h1 className="display welcome-title">Laundry,<br/><em>without</em> the<br/>guesswork.</h1><p className="welcome-desc">A calmer way to share the washers. Book your time, see your duty, and hand over with confidence.</p>
        <div className="welcome-actions"><Link href="/sign-up" className="button button-primary focus-ring" data-testid="link-get-started">Get started <ArrowRight size={16}/></Link><span className="welcome-note"><ShieldCheck size={15}/> Fair slots. Clear handovers.</span></div>
      </div>
      <div className="welcome-visual" aria-label="Laundry room schedule preview">
        <div className="visual-orbit orbit-one"/><div className="visual-orbit orbit-two"/>
        <div className="washer washer-back"><div className="washer-top"/><div className="washer-door"><div/></div><div className="washer-knob"/></div>
        <div className="washer washer-front"><div className="washer-top"/><div className="washer-door"><div/></div><div className="washer-knob"/></div>
        <div className="visual-tag tag-top"><span className="live-dot"/> OPEN SLOT <b>10:30 AM</b></div>
        <div className="visual-tag tag-bottom"><ShieldCheck size={15}/><span>Duty rotation<br/><b>kept balanced</b></span></div>
        <div className="visual-counter"><span>THIS WEEKEND</span><b>Room for<br/>everyone.</b><div><i/><i/><i/><i/><i/><i/><i/></div></div>
      </div>
    </div>
    <div className="welcome-bottom"><span>Made for the little routines we share.</span><span>BOOK · WASH · PASS IT ON</span></div>
    <div className="welcome-auth"><Link href="/sign-in" data-testid="link-welcome-sign-in">Already have an account? Sign in</Link></div>
  </div>;
}

function HomeRedirect() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-loading"><Loading label="Preparing your space"/></div>;
  return isSignedIn ? <Redirect to="/user-portal"/> : <Home/>;
}
function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-loading"><Loading label="Checking your session"/></div>;
  return isSignedIn ? <Shell>{children}</Shell> : <Redirect to="/"/>;
}
function ClerkQueryCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  useEffect(() => {
    let last: string | null | undefined;
    return addListener(({ user }) => {
      const id = user?.id ?? null;
      if (last !== undefined && last !== id) qc.clear();
      last = id;
    });
  }, [addListener, qc]);
  return null;
}

function DashboardPage() {
  const query = useGetLaundryDashboard();
  const health = useHealthCheck();
  if (query.isLoading) return <Loading/>;
  if (query.isError || !query.data) return <QueryError retry={() => { query.refetch(); health.refetch(); }}/>;
  const d = query.data;
  return <>
    <div className="dash-heading"><div><div className="eyebrow">YOUR WEEKEND, IN GOOD ORDER</div><h1 className="display page-title">Hello, {d.student.name.split(' ')[0]}.</h1><p className="subhead">A little room for the things that matter.</p></div><div className="room-pill"><DoorOpen size={16}/><span>ROOM {d.student.room}</span></div></div>
    <div className="weekend-banner"><div className="banner-copy"><span className="banner-kicker">THE NEXT WASH CYCLE</span><h2 className="display">{d.nextBooking ? 'Your time is set.' : 'Make room for laundry.'}</h2><p>{d.nextBooking ? `${fmt(d.nextBooking.startAt)} · ${d.nextBooking.machineName}` : 'Pick a weekend slot that works for you.'}</p><Link href={d.nextBooking ? '/bookings' : '/book'} className="banner-link" data-testid="link-banner-action">{d.nextBooking ? 'View your booking' : 'Find a time'} <ArrowRight size={15}/></Link></div><div className="banner-illustration"><WashingMachine size={52} strokeWidth={1.1}/><span className="cycle-ring"/></div><span className="banner-index">01 / 02</span></div>
    <div className="dashboard-grid">
      <Panel className="next-card" testId="card-next-booking"><div className="card-topline"><span className="eyebrow">UP NEXT</span><Badge tone={d.nextBooking ? 'good' : 'neutral'}>{d.nextBooking ? d.nextBooking.status : 'No booking'}</Badge></div><div className="next-icon"><CalendarDays size={20}/></div><h3 className="display card-heading">{d.nextBooking ? fmt(d.nextBooking.startAt, { weekday: 'long', month: 'long', day: 'numeric' }) : 'Your next wash'}</h3><p className="card-muted">{d.nextBooking ? `${timeRange(d.nextBooking.startAt, d.nextBooking.endAt)} · ${d.nextBooking.machineName}` : 'Choose an open half-hour and make it yours.'}</p><Link className="text-link" href={d.nextBooking ? '/bookings' : '/book'} data-testid="link-dashboard-booking">{d.nextBooking ? 'See booking' : 'Browse slots'} <ArrowRight size={14}/></Link></Panel>
      <Panel className="duty-card" testId="card-next-duty"><div className="card-topline"><span className="eyebrow">ON THE ROTA</span><Badge tone={d.nextDuty ? statusTone(d.nextDuty.status) : 'neutral'}>{d.nextDuty ? d.nextDuty.status : 'All clear'}</Badge></div><div className="next-icon duty-icon"><ShieldCheck size={20}/></div><h3 className="display card-heading">{d.nextDuty ? fmt(d.nextDuty.startAt, { weekday: 'long', month: 'long', day: 'numeric' }) : 'No duty assigned'}</h3><p className="card-muted">{d.nextDuty ? `${timeRange(d.nextDuty.startAt, d.nextDuty.endAt)} · with ${d.nextDuty.partnerName}` : 'Your turn will appear here when assigned.'}</p><Link className="text-link" href="/duties" data-testid="link-dashboard-duty">View duty rota <ArrowRight size={14}/></Link></Panel>
    </div>
    <div className="section-heading"><div><div className="eyebrow">A FAIR SHARE</div><h2 className="display section-title">Your part of the rhythm.</h2></div><Link href="/duties" className="text-link" data-testid="link-view-rotation">See rotation <ArrowRight size={14}/></Link></div>
    <div className="rhythm-strip"><div className="rhythm-stat"><span className="eyebrow">THIS WEEKEND</span><b data-testid="text-weekend-bookings">{d.weekendBookings}</b><span>bookings</span></div><div className="rhythm-divider"/><div className="rhythm-stat"><span className="eyebrow">ON YOUR ROTA</span><b data-testid="text-weekend-duties">{d.weekendDuties}</b><span>duty shifts</span></div><div className="rhythm-divider"/><div className="rhythm-stat"><span className="eyebrow">DUTIES DONE</span><b data-testid="text-duties-completed">{d.student.dutiesCompleted}</b><span>completed</span></div><Link href="/qr-codes" className="rhythm-action" data-testid="link-get-credentials"><span className="rhythm-action-icon"><ScanLine size={18}/></span><span><b>Your credentials</b><small>Ready when you are</small></span><ChevronRight size={16}/></Link></div>
    <div className="dashboard-footnote"><Sparkles size={15}/><span>Two students on every duty. One shared room, looked after together.</span></div>
  </>;
}

function BookingsPage() {
  const q = useGetLaundryBookings();
  const qc = useQueryClient();
  const cancel = useCancelLaundryBooking();
  const [busyId, setBusyId] = useState<number | null>(null);
  const items = q.data ?? [];
  const handleCancel = (id: number) => {
    if (!window.confirm('Cancel this laundry booking?')) return;
    setBusyId(id); buzz();
    cancel.mutate({ bookingId: id }, { onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLaundryBookingsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryDashboardQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryQrCodesQueryKey() });
    }, onSettled: () => setBusyId(null) });
  };
  if (q.isLoading) return <Loading/>;
  if (q.isError) return <QueryError retry={() => q.refetch()}/>;
  return <><Title eyebrow="YOUR WASH TIMES" aside={<Link href="/book" className="button button-primary" data-testid="link-new-booking"><CalendarDays size={16}/> Book a slot</Link>}>My bookings</Title>
    <p className="subhead page-intro">Your place in the laundry-room rhythm.</p>
    {items.length ? <div className="list-stack">{items.map((b: LaundryBooking) => <Panel key={b.id} className="booking-row" testId={`card-booking-${b.id}`}><div className="booking-date"><span>{fmt(b.startAt, { weekday: 'short' }).toUpperCase()}</span><b>{fmt(b.startAt, { day: '2-digit' })}</b><small>{fmt(b.startAt, { month: 'short' }).toUpperCase()}</small></div><div className="booking-details"><div className="booking-name">{b.machineName}<Badge tone={statusTone(b.status)}>{b.status}</Badge></div><p>{fmt(b.startAt, { weekday: 'long', month: 'long', day: 'numeric' })}</p><span><Clock3 size={14}/>{timeRange(b.startAt, b.endAt)}</span></div><div className="booking-actions">{b.status === 'upcoming' && <Button variant="quiet" className="cancel-action" testId={`button-cancel-${b.id}`} disabled={busyId === b.id} onClick={() => handleCancel(b.id)}>{busyId === b.id ? <LoaderCircle size={15} className="spin"/> : <X size={15}/>} Cancel</Button>}</div></Panel>)}</div>
      : <Panel className="empty-panel"><Empty title="Nothing in the queue yet" detail="When you book a half-hour slot, it’ll be waiting here." action={<Link href="/book" className="button button-primary" data-testid="link-empty-book">Find a slot <ArrowRight size={15}/></Link>}/></Panel>}
  </>;
}

function dateFromDay(dayOffset: number) {
  const d = new Date(); d.setDate(d.getDate() + dayOffset); return d.toISOString().slice(0, 10);
}
function weekendDates() {
  const now = new Date(); const day = now.getDay();
  const daysUntilSat = (6 - day + 7) % 7;
  return [dateFromDay(daysUntilSat), dateFromDay(daysUntilSat + 1)];
}
function BookPage() {
  const dates = useMemo(weekendDates, []);
  const [date, setDate] = useState(dates[0]);
  const [selected, setSelected] = useState<LaundrySlot | null>(null);
  const slots = useGetLaundrySlots({ date }, { query: { queryKey: getGetLaundrySlotsQueryKey({ date }) } });
  const qc = useQueryClient();
  const create = useCreateLaundryBooking();
  const bookings = useGetLaundryBookings();
  const duties = useGetLaundryDuties();
  const dayLabel = (v: string) => new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date(`${v}T12:00:00`));
  const overlap = (slot: LaundrySlot) => {
    const start = new Date(slot.startAt).getTime(), end = new Date(slot.endAt).getTime();
    return (bookings.data ?? []).some((b: LaundryBooking) => b.status !== 'cancelled' && start < new Date(b.endAt).getTime() && end > new Date(b.startAt).getTime())
      || (duties.data ?? []).some((d: DutyAssignment) => d.status !== 'missed' && start < new Date(d.endAt).getTime() && end > new Date(d.startAt).getTime());
  };
  const book = () => {
    if (!selected) return;
    buzz([14, 30, 14]);
    create.mutate({ data: { startAt: selected.startAt, machineId: selected.machineId } }, { onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLaundrySlotsQueryKey({ date }) });
      qc.invalidateQueries({ queryKey: getGetLaundryBookingsQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryDashboardQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryQrCodesQueryKey() });
      setSelected(null);
    } });
  };
  return <><Title eyebrow="MAKE A LITTLE SPACE">Book a slot</Title><p className="subhead page-intro">Half-hour turns, shared fairly. Choose Saturday or Sunday.</p>
    <div className="date-switch" role="tablist" aria-label="Choose weekend day">{dates.map((day, i) => <button key={day} role="tab" aria-selected={day === date} data-testid={`button-day-${i}`} className={`date-tab focus-ring ${day === date ? 'date-tab-active' : ''}`} onClick={() => { setDate(day); setSelected(null); buzz(); }}><span>{i === 0 ? 'SATURDAY' : 'SUNDAY'}</span><b>{dayLabel(day).split(', ').slice(1).join(', ')}</b><small>8:00 AM — 2:00 AM</small></button>)}</div>
    <Panel className="slot-panel"><div className="slot-panel-head"><div><div className="eyebrow">AVAILABLE HALF-HOURS</div><h2 className="display section-title">{dayLabel(date)}</h2></div><span className="slot-count">{slots.data?.filter((s: LaundrySlot) => s.available && !overlap(s)).length ?? '—'} open</span></div>
      {slots.isLoading ? <div className="slot-skeleton"><div/><div/><div/><div/><div/><div/></div> : slots.isError ? <QueryError retry={() => slots.refetch()}/> : !(slots.data?.length) ? <Empty title="The schedule is being set" detail="No slots are available to display right now. Check again soon."/> : <div className="slot-grid">{(slots.data ?? []).map((slot: LaundrySlot) => {
        const blocked = !slot.available || overlap(slot);
        const isSelected = selected?.startAt === slot.startAt && selected.machineId === slot.machineId;
        return <button key={`${slot.startAt}-${slot.machineId}`} disabled={blocked} onClick={() => { setSelected(slot); buzz(); }} data-testid={`button-slot-${slot.machineId}-${new Date(slot.startAt).getTime()}`} className={`slot-button focus-ring ${isSelected ? 'slot-selected' : ''} ${blocked ? 'slot-unavailable' : ''}`} aria-pressed={isSelected}>
          <span>{fmt(slot.startAt, { hour: 'numeric', minute: '2-digit' })}</span><small>{slot.machineName}</small>{isSelected && <Check size={13}/>}
        </button>;
      })}</div>}
      <div className="slot-legend"><span><i className="legend-dot open"/>Available</span><span><i className="legend-dot selected"/>Selected</span><span><i className="legend-dot unavailable"/>Taken or overlapping</span></div>
    </Panel>
    {selected && <div className="booking-confirm-bar"><div><span className="eyebrow">YOUR PICK</span><b>{timeRange(selected.startAt, selected.endAt)}</b><small>{selected.machineName} · {dayLabel(date)}</small></div><Button testId="button-confirm-booking" onClick={book} disabled={create.isPending}>{create.isPending ? <LoaderCircle className="spin" size={17}/> : <Check size={17}/>} {create.isPending ? 'Booking…' : 'Confirm booking'}</Button></div>}
    {create.isError && <div role="alert" className="inline-error" data-testid="status-booking-error">That slot couldn’t be booked. It may have just been taken—please choose another.</div>}
    <p className="fine-print"><ShieldCheck size={14}/> Booking is subject to availability and shared-room fairness rules.</p>
  </>;
}

function DutiesPage() {
  const q = useGetLaundryDuties();
  if (q.isLoading) return <Loading label="Checking the rota"/>;
  if (q.isError) return <QueryError retry={() => q.refetch()}/>;
  const duties = q.data ?? [];
  return <><Title eyebrow="SHARED CARE, SHARED FAIRLY">Duty rota</Title><p className="subhead page-intro">Two people on each shift keeps the room moving.</p>
    <Panel className="duty-intro"><span className="duty-intro-icon"><ShieldCheck size={22}/></span><div><b>Every turn makes a difference.</b><p>Be there for your shift, then confirm the handover so the next pair can get started.</p></div><span className="duty-intro-mark mono">02<br/>PEOPLE</span></Panel>
    {duties.length ? <div className="list-stack duty-list">{duties.map((d: DutyAssignment) => <Panel key={d.id} className="duty-row" testId={`card-duty-${d.id}`}><div className={`duty-status-mark ${statusTone(d.status)}`}><ShieldCheck size={18}/></div><div className="duty-details"><div className="booking-name">{fmt(d.startAt, { weekday: 'long', month: 'short', day: 'numeric' })}<Badge tone={statusTone(d.status)}>{d.status}</Badge></div><p><Clock3 size={14}/>{timeRange(d.startAt, d.endAt)}</p><span>Duty partner <b>{d.partnerName}</b> · Room {d.room}</span><div className="confirmations"><span className={d.outgoingConfirmed ? 'confirmed' : ''}><CheckCircle2 size={13}/> Outgoing {d.outgoingConfirmed ? 'confirmed' : 'pending'}</span><span className={d.incomingConfirmed ? 'confirmed' : ''}><CheckCircle2 size={13}/> Incoming {d.incomingConfirmed ? 'confirmed' : 'pending'}</span></div></div><Link href="/handover" className="icon-link" aria-label="Open handover" data-testid={`link-duty-handover-${d.id}`}><ArrowRight size={18}/></Link></Panel>)}</div> : <Panel className="empty-panel"><Empty title="No shifts on your rota" detail="When a duty is assigned, your shift and partner will appear here."/></Panel>}
    <div className="duty-foot"><span><b>Fair rotation</b><small>Assignments are balanced across the hostel.</small></span><Link href="/handover" className="button button-outline" data-testid="link-duty-handover">Confirm handover <ArrowRight size={15}/></Link></div>
  </>;
}

function QrPage() {
  const q = useGetLaundryQrCodes();
  const copyToken = async (token: string, id: number) => {
    try { await navigator.clipboard.writeText(token); buzz(); document.dispatchEvent(new CustomEvent('credential-copied', { detail: id })); } catch { /* Clipboard unavailable; token remains selectable. */ }
  };
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    const handler = (event: Event) => setCopied((event as CustomEvent<number>).detail);
    document.addEventListener('credential-copied', handler);
    return () => document.removeEventListener('credential-copied', handler);
  }, []);
  if (q.isLoading) return <Loading label="Gathering your credentials"/>;
  if (q.isError) return <QueryError retry={() => q.refetch()}/>;
  const credentials = q.data ?? [];
  return <><Title eyebrow="READY WHEN YOU ARE">Your credentials</Title><p className="subhead page-intro">Booking and duty QR credentials for supervised check-in.</p>
    <div className="credential-notice"><ScanLine size={17}/><p>Present these QR codes to your duty supervisor for immediate camera scan, or provide the 8-character token code.</p></div>
    {credentials.length ? <div className="credential-grid">{credentials.map((c: QrCredential) => <Panel key={`${c.kind}-${c.id}`} className="credential-card" testId={`card-credential-${c.kind}-${c.id}`}><div className="credential-card-top"><Badge tone={c.kind === 'duty' ? 'warm' : 'good'}>{c.kind}</Badge><Badge tone={statusTone(c.status)}>{c.status}</Badge></div>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0', padding: '12px', background: '#ffffff', borderRadius: '14px', border: '1px solid #dcd8cd', width: 'fit-content', marginLeft: 'auto', marginRight: 'auto' }}>
        <QRCodeSVG value={c.token} size={140} level="M" bgColor="#ffffff" fgColor="#26363a" />
      </div>
      <h2 className="display credential-title">{c.label}</h2><p className="credential-time">{fmt(c.startAt, { weekday: 'long', month: 'long', day: 'numeric' })}<br/>{timeRange(c.startAt, c.endAt)}</p><div className="token-value"><span className="mono" data-testid={`text-token-${c.id}`}>{c.token}</span><button className="copy-button focus-ring" onClick={() => copyToken(c.token, c.id)} data-testid={`button-copy-token-${c.id}`} aria-label="Copy access token">{copied === c.id ? <Check size={16}/> : <Copy size={16}/>}</button></div>{copied === c.id && <span className="copy-feedback" role="status">Token copied</span>}<p className="credential-disclaimer">Scannable QR credential. Verified against real-time slot roster.</p></Panel>)}</div>
      : <Panel className="empty-panel"><Empty title="No active credentials" detail="Once you have a booking or duty shift, the right QR credential will appear here." action={<Link href="/book" className="button button-primary" data-testid="link-credential-book">Book a slot <ArrowRight size={15}/></Link>}/></Panel>}
  </>;
}

function ScanPage() {
  const verify = useVerifyLaundryQr();
  const [token, setToken] = useState('');
  const [result, setResult] = useState<QrVerificationResult | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<{ stop: () => void } | null>(null);

  const stopCamera = () => {
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    setCameraActive(false);
  };

  const startCamera = async () => {
    setCameraError(null);
    setCameraActive(true);
    buzz(15);
    setTimeout(async () => {
      if (!videoRef.current) return;
      try {
        const codeReader = new BrowserQRCodeReader();
        const controls = await codeReader.decodeFromVideoDevice(
          undefined,
          videoRef.current,
          (res) => {
            if (res) {
              const text = res.getText();
              if (text && text.trim().length >= 8) {
                setToken(text.trim());
                controls.stop();
                controlsRef.current = null;
                setCameraActive(false);
                buzz([18, 35, 18]);
                verify.mutate({ data: { token: text.trim() } }, {
                  onSuccess: (r) => setResult(r),
                });
              }
            }
          }
        );
        controlsRef.current = controls;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Camera access unavailable';
        setCameraError(`${msg}. Please enter token manually.`);
        setCameraActive(false);
      }
    }, 120);
  };

  useEffect(() => {
    return () => {
      if (controlsRef.current) {
        controlsRef.current.stop();
      }
    };
  }, []);

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (token.trim().length < 8) return;
    buzz();
    setResult(null);
    verify.mutate({ data: { token: token.trim() } }, {
      onSuccess: (r) => {
        setResult(r);
        buzz(r.valid ? [18, 35, 18] : 45);
      },
    });
  };

  return <><Title eyebrow="A QUICK CHECK, DONE RIGHT">Verify a token</Title><p className="subhead page-intro">Scan a student’s QR code with your camera or enter their credential token.</p>
    <Panel className="verify-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="verify-icon"><ScanLine size={22}/></span>
          <div>
            <h2 className="display section-title" style={{ margin: 0 }}>Supervised check-in</h2>
            <p style={{ margin: 0, fontSize: 13, color: '#687574' }}>Live QR scanning or manual token lookup</p>
          </div>
        </div>
        <Button variant={cameraActive ? 'danger' : 'outline'} testId="button-toggle-camera" onClick={cameraActive ? stopCamera : startCamera}>
          {cameraActive ? <CameraOff size={16}/> : <Camera size={16}/>} {cameraActive ? 'Close camera' : 'Scan with camera'}
        </Button>
      </div>

      {cameraActive && (
        <div style={{ marginBottom: 20, textAlign: 'center' }}>
          <div style={{ position: 'relative', width: '100%', maxWidth: 360, margin: '0 auto', overflow: 'hidden', borderRadius: 16, background: '#1c2426' }}>
            <video ref={videoRef} style={{ width: '100%', height: 260, objectFit: 'cover' }} playsInline muted />
            <div style={{ position: 'absolute', inset: 30, border: '2px dashed #287765', borderRadius: 12, pointerEvents: 'none' }} />
          </div>
          <p style={{ fontSize: 12, color: '#687574', marginTop: 8 }}>Point your camera directly at the student’s QR code</p>
        </div>
      )}

      {cameraError && <div className="inline-error" style={{ marginBottom: 14 }}>{cameraError}</div>}

      <form onSubmit={submit} className="token-form">
        <label htmlFor="verify-token">Credential token</label>
        <div className="input-with-icon"><KeyRound size={17}/><input id="verify-token" data-testid="input-verify-token" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste or enter token" minLength={8} required/></div>
        <Button type="submit" testId="button-verify-token" disabled={verify.isPending || token.trim().length < 8}>
          {verify.isPending ? <LoaderCircle size={16} className="spin"/> : <ShieldCheck size={16}/>} {verify.isPending ? 'Verifying…' : 'Verify credential'}
        </Button>
      </form>
      {verify.isError && <div className="verify-result verify-invalid" role="alert" data-testid="status-verify-error"><X size={18}/><span>Couldn’t verify this token. Check the value and try again.</span></div>}
      {result && <div className={`verify-result ${result.valid ? 'verify-valid' : 'verify-invalid'}`} data-testid="status-verification-result">{result.valid ? <BadgeCheck size={19}/> : <X size={19}/>}<span><b>{result.valid ? 'Credential verified' : 'Not verified'}</b><small>{result.message}</small>{result.valid && result.relatedId && <small>{result.kind === 'duty' ? 'Duty assignment' : 'Booking'} · reference {result.relatedId}</small>}</span></div>}
    </Panel>
    <div className="fine-print"><ShieldCheck size={14}/> Only a successful service verification should be used to confirm a handover.</div>
  </>;
}


function HandoverPage() {
  const duties = useGetLaundryDuties();
  const verify = useVerifyLaundryQr();
  const complete = useCompleteLaundryHandover();
  const qc = useQueryClient();
  const [dutyId, setDutyId] = useState('');
  const [partnerToken, setPartnerToken] = useState('');
  const [verified, setVerified] = useState(false);
  const [verifyMessage, setVerifyMessage] = useState('');
  const pending = (duties.data ?? []).filter((d: DutyAssignment) => d.status !== 'completed');
  const checkToken = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setVerified(false); buzz();
    verify.mutate({ data: { token: partnerToken.trim() } }, { onSuccess: (r) => {
      setVerified(r.valid && r.kind === 'duty'); setVerifyMessage(r.message);
      if (r.valid && r.kind !== 'duty') setVerifyMessage('This is a booking token. Use a duty token for a handover.');
      buzz(r.valid && r.kind === 'duty' ? [18, 35, 18] : 40);
    } });
  };
  const confirmHandover = () => {
    if (!verified || !dutyId || !partnerToken.trim()) return;
    buzz([15, 32, 15]);
    complete.mutate({ data: { dutyId: Number(dutyId), partnerToken: partnerToken.trim() } }, { onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLaundryDutiesQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryDashboardQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryMeQueryKey() });
      setPartnerToken(''); setVerified(false); setVerifyMessage('');
    } });
  };
  if (duties.isLoading) return <Loading label="Loading handover details"/>;
  if (duties.isError) return <QueryError retry={() => duties.refetch()}/>;
  return <><Title eyebrow="PASS IT ON, PROPERLY">Confirm handover</Title><p className="subhead page-intro">Verify the incoming supervisor, then record the room transition.</p>
    <div className="handover-steps"><div className="step-line"><span className={verified ? 'step-done' : 'step-current'}>{verified ? <Check size={15}/> : '01'}</span><div><b>Verify the partner</b><small>Use their duty token</small></div></div><div className="step-connector"/><div className="step-line"><span className={verified ? 'step-current' : ''}>{verified ? '02' : '02'}</span><div><b>Confirm the handover</b><small>Only after verification</small></div></div></div>
    <Panel className="handover-panel"><form onSubmit={checkToken} className="token-form"><label htmlFor="handover-duty">Duty assignment</label><select id="handover-duty" data-testid="select-handover-duty" value={dutyId} onChange={(e) => { setDutyId(e.target.value); setVerified(false); }} required><option value="">Select your duty</option>{pending.map((d: DutyAssignment) => <option key={d.id} value={d.id}>{fmt(d.startAt, { weekday: 'short', month: 'short', day: 'numeric' })} · {timeRange(d.startAt, d.endAt)} · {d.partnerName}</option>)}</select><label htmlFor="partner-token">Partner’s duty token</label><div className="input-with-icon"><KeyRound size={17}/><input id="partner-token" data-testid="input-partner-token" value={partnerToken} onChange={(e) => { setPartnerToken(e.target.value); setVerified(false); }} minLength={8} placeholder="Enter verified duty token" required/></div><Button type="submit" testId="button-check-partner" variant="outline" disabled={verify.isPending || partnerToken.trim().length < 8}>{verify.isPending ? <LoaderCircle size={16} className="spin"/> : <ScanLine size={16}/>} {verify.isPending ? 'Checking…' : 'Verify partner token'}</Button></form>
      {verified && <div className="verify-result verify-valid" data-testid="status-partner-verified"><BadgeCheck size={19}/><span><b>Duty token verified</b><small>{verifyMessage}</small></span></div>}
      {!verified && verifyMessage && <div className="verify-result verify-invalid" data-testid="status-partner-invalid"><X size={18}/><span>{verifyMessage}</span></div>}
      {verify.isError && <div className="inline-error" role="alert">The service couldn’t verify the token. Please try again.</div>}
      <div className="handover-rule"><ShieldCheck size={16}/><span>We’ll only record a handover after the partner’s duty token is verified.</span></div>
      <Button className="handover-confirm" testId="button-confirm-handover" disabled={!verified || !dutyId || complete.isPending} onClick={confirmHandover}>{complete.isPending ? <LoaderCircle size={17} className="spin"/> : <Check size={17}/>} {complete.isPending ? 'Recording…' : 'Confirm handover'}</Button>
      {complete.isError && <div className="inline-error" role="alert" data-testid="status-handover-error">The handover could not be recorded. Please check the duty and try again.</div>}
      {complete.isSuccess && <div className="success-note" role="status" data-testid="status-handover-success"><CheckCircle2 size={17}/> Handover recorded. Thanks for looking after the room.</div>}
    </Panel></>;
}

function ProfilePage() {
  const q = useGetLaundryMe();
  const qc = useQueryClient();
  const update = useUpdateLaundryMe();
  const { user } = useUser();
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  useEffect(() => {
    if (q.data) { setName(q.data.name); setRoom(q.data.room); }
  }, [q.data]);
  if (q.isLoading) return <Loading label="Loading your profile"/>;
  if (q.isError || !q.data) return <QueryError retry={() => q.refetch()}/>;
  const p = q.data;
  const save = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    update.mutate({ data: { name: name.trim(), room: room.trim() } }, { onSuccess: () => {
      qc.invalidateQueries({ queryKey: getGetLaundryMeQueryKey() });
      qc.invalidateQueries({ queryKey: getGetLaundryDashboardQueryKey() });
      buzz([12, 25, 12]);
    } });
  };
  return <><Title eyebrow="YOUR ACCOUNT">My profile</Title><p className="subhead page-intro">Your place in the shared laundry room.</p><Panel className="profile-panel"><div className="profile-avatar-large">{(p.name.match(/\b\w/g) ?? ['S']).slice(0, 2).join('')}</div><div><h2 className="display profile-name" data-testid="text-student-name">{p.name}</h2><p className="profile-email">{user?.primaryEmailAddress?.emailAddress ?? 'Student account'}</p><Badge tone={p.role === 'manager' ? 'warm' : 'good'}>{p.role}</Badge></div><div className="profile-room"><span className="eyebrow">ROOM</span><b data-testid="text-student-room">{p.room}</b></div></Panel>
    <Panel className="profile-edit-panel"><div className="eyebrow">KEEP IT CURRENT</div><h2 className="display section-title">Your details</h2><p className="card-muted">Name and room help the rota stay clear for everyone.</p><form className="profile-form" onSubmit={save}><label htmlFor="profile-name">Name</label><input id="profile-name" data-testid="input-profile-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required/><label htmlFor="profile-room">Room</label><input id="profile-room" data-testid="input-profile-room" value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} required/><Button type="submit" testId="button-save-profile" disabled={update.isPending || !name.trim() || !room.trim()}>{update.isPending ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>} {update.isPending ? 'Saving…' : 'Save changes'}</Button>{update.isError && <span className="inline-error" role="alert" data-testid="status-profile-error">Your changes couldn’t be saved. Try again.</span>}{update.isSuccess && <span className="success-note" role="status" data-testid="status-profile-saved"><CheckCircle2 size={16}/> Profile updated.</span>}</form></Panel>
    <div className="profile-stats"><Panel><span className="eyebrow">DUTIES COMPLETED</span><b data-testid="text-profile-completed">{p.dutiesCompleted}</b><small>Thanks for sharing the care.</small></Panel><Panel><span className="eyebrow">DUTIES OUTSTANDING</span><b data-testid="text-profile-outstanding">{p.dutiesOutstanding}</b><small>Every shift keeps things fair.</small></Panel></div><Panel className="account-card"><div className="account-mark"><UserRound size={18}/></div><div><b>Account managed securely</b><p>Your sign-in and personal details are protected by Clerk.</p></div><ExternalLink size={15}/></Panel></>;
}

function ManagerPage() {
  const profile = useGetLaundryMe();
  const q = useGetManagementOverview({ query: { enabled: profile.data?.role === 'manager', queryKey: getGetManagementOverviewQueryKey() } });
  if (profile.isLoading) return <Loading label="Checking manager access"/>;
  if (profile.isError) return <QueryError retry={() => profile.refetch()}/>;
  if (profile.data?.role !== 'manager') return <div className="unauthorized"><div className="unauthorized-mark"><KeyRound size={21}/></div><div className="eyebrow">MANAGER ACCESS ONLY</div><h1 className="display page-title">This view is for the rota team.</h1><p>Your student account doesn’t have access to the manager overview.</p><Link href="/user-portal" className="button button-primary" data-testid="link-return-dashboard">Return to your overview <ArrowRight size={15}/></Link></div>;
  if (q.isLoading) return <Loading label="Loading the hostel overview"/>;
  if (q.isError || !q.data) return <QueryError retry={() => q.refetch()}/>;
  const m = q.data;
  return <><Title eyebrow="ROOM-WIDE PICTURE">Manager overview</Title><p className="subhead page-intro">A steady view of bookings, duty care and handovers.</p><div className="manager-metrics"><Panel><span className="metric-icon"><Users size={18}/></span><span className="eyebrow">STUDENTS</span><b data-testid="text-manager-students">{m.students}</b><small>in the hostel</small></Panel><Panel><span className="metric-icon"><WashingMachine size={18}/></span><span className="eyebrow">ACTIVE BOOKINGS</span><b data-testid="text-manager-bookings">{m.activeBookings}</b><small>currently in motion</small></Panel><Panel><span className="metric-icon"><ShieldCheck size={18}/></span><span className="eyebrow">DUTIES COMPLETED</span><b data-testid="text-manager-duties">{m.completedDuties}</b><small>shared shifts done</small></Panel><Panel><span className="metric-icon warm"><ArrowDownLeft size={18}/></span><span className="eyebrow">PENDING HANDOVERS</span><b data-testid="text-manager-handovers">{m.pendingHandovers}</b><small>awaiting confirmation</small></Panel></div><Panel className="coverage-panel"><div className="coverage-heading"><div><div className="eyebrow">WEEKEND COVERAGE</div><h2 className="display section-title">Every shift, accounted for.</h2></div><Badge tone="good"><span className="live-dot"/> Live overview</Badge></div>{m.weekendCoverage.length ? <div className="coverage-list">{m.weekendCoverage.map((item, i) => { const pct = item.required > 0 ? Math.min(100, item.assigned / item.required * 100) : 0; return <div className="coverage-row" key={`${item.startAt}-${i}`} data-testid={`coverage-row-${i}`}><div className="coverage-time"><span>{fmt(item.startAt, { weekday: 'short' })}</span><b>{fmt(item.startAt, { hour: 'numeric', minute: '2-digit' })}</b></div><div className="coverage-track"><div className="coverage-fill" style={{ transform: `scaleX(${pct / 100})` }}/></div><span className="coverage-count mono">{item.assigned}<i>/</i>{item.required}</span><Badge tone={pct >= 100 ? 'good' : 'warm'}>{pct >= 100 ? 'Covered' : 'Needs cover'}</Badge></div>; })}</div> : <Empty title="No coverage shifts to show" detail="Weekend shift assignments will appear as the rota is set."/>}</Panel><div className="manager-note"><ShieldCheck size={16}/><span>This overview is restricted to accounts with the manager role.</span></div></>;
}

function StudentRoute({ page }: { page: ReactNode }) {
  return <Protected>{page}</Protected>;
}
function SignInPage() {
  return <div className="auth-screen"><Link href="/" className="auth-home-brand" data-testid="link-auth-brand-signin"><span className="brand-mark"><Droplets size={17}/></span><span><b>WASHROOM</b><small>HOSTEL LAUNDRY</small></span></Link><div className="auth-frame"><div className="auth-head"><div className="eyebrow">YOUR SHARED SPACE</div><h1 className="display">Welcome back.</h1><p>Sign in to see your wash times and duty.</p></div><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}/></div><p className="auth-footer">A little room for everyone.</p></div>;
}
function SignUpPage() {
  return <div className="auth-screen"><Link href="/" className="auth-home-brand" data-testid="link-auth-brand-signup"><span className="brand-mark"><Droplets size={17}/></span><span><b>WASHROOM</b><small>HOSTEL LAUNDRY</small></span></Link><div className="auth-frame"><div className="auth-head"><div className="eyebrow">JOIN THE ROOM</div><h1 className="display">Make yourself at home.</h1><p>Set up your account to book and share fairly.</p></div><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`}/></div><p className="auth-footer">A little room for everyone.</p></div>;
}
function Router() {
  return <Switch>
    <Route path="/" component={HomeRedirect}/>
    <Route path="/sign-in/*?" component={SignInPage}/>
    <Route path="/sign-up/*?" component={SignUpPage}/>
    <Route path="/user-portal"><StudentRoute page={<DashboardPage/>}/></Route>
    <Route path="/bookings"><StudentRoute page={<BookingsPage/>}/></Route>
    <Route path="/book"><StudentRoute page={<BookPage/>}/></Route>
    <Route path="/duties"><StudentRoute page={<DutiesPage/>}/></Route>
    <Route path="/qr-codes"><StudentRoute page={<QrPage/>}/></Route>
    <Route path="/scan"><StudentRoute page={<ScanPage/>}/></Route>
    <Route path="/handover"><StudentRoute page={<HandoverPage/>}/></Route>
    <Route path="/manager"><StudentRoute page={<ManagerPage/>}/></Route>
    <Route path="/profile"><StudentRoute page={<ProfilePage/>}/></Route>
    <Route component={NotFound}/>
  </Switch>;
}
function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}
function ClerkRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`}
    localization={{ signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access your laundry space' } }, signUp: { start: { title: 'Join your laundry room', subtitle: 'Get started with fair, shared laundry' } } }}
    routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}>
    <QueryClientProvider client={queryClient}><TooltipProvider><ClerkQueryCacheInvalidator/><RoutedErrorBoundary><Router/></RoutedErrorBoundary><Toaster/></TooltipProvider></QueryClientProvider>
  </ClerkProvider>;
}
function App() {
  return <WouterRouter base={basePath}><ClerkRoutes/></WouterRouter>;
}
export default App;
