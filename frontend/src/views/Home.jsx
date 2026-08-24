import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { effectiveRoutine, effectiveRoutineId, streakWeeks, lastBW, setsDoneActive } from '../lib/history.js'
import { fmtNum, fmtDate, todayISO, isoOf, weekKey, DAYS, MONTHS, MONTHS_LONG } from '../lib/format.js'
import { PERIODS, weekDays, monthGrid, yearMonths, periodLabel } from '../lib/calendar.js'
import { t, dateLocale } from '../lib/i18n.js'
import { bwSheet, goalSheet, dayOverrideSheet, calendarSheet, startFlow, loadStarterPlan, bwDeltaColor } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { glyphOf } from '../lib/glyphs.js'

// Home = what to do now + a quick glance. Deep charts & history live in Stats.
export default function Home() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  // The strip shows one period at a time and steps through it. Changing period resets the
  // offset: "two months back" has no meaning once you switch to years, and landing on a
  // random year is worse than landing on this one.
  const [period, setPeriod] = useState('week')
  const [offset, setOffset] = useState(0)
  const step = d => setOffset(o => o + d)
  const switchTo = p => { setPeriod(p); setOffset(0) }

  const today = new Date()
  const routine = effectiveRoutine(S, todayISO())
  const todayOvr = S.dayPlan[todayISO()] !== undefined
  const bw = lastBW(S)
  const prevBW = S.bodyweight.length > 1 ? S.bodyweight[S.bodyweight.length - 2] : null
  const delta = bw && prevBW ? bw.w - prevBW.w : null

  const doneDays = new Set(S.workouts.map(w => w.d))
  // One dot per day, meaning the same thing in the week and the month grid: trained, moved
  // here from another day, or planned.
  const dotFor = iso => {
    const eff = effectiveRoutineId(S, iso)
    return doneDays.has(iso) ? ' done' : S.dayPlan[iso] !== undefined && eff ? ' ovr' : eff ? ' plan' : ''
  }
  const dayCell = (iso, label, num, extra = '') =>
    <div key={iso + extra} className={'wday' + (iso === todayISO() ? ' today' : '') + extra}
      role="button" tabIndex={0} aria-label={fmtDate(iso)}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dayOverrideSheet(iso) } }}
      onClick={() => dayOverrideSheet(iso)}>
      {label !== null && <div className="lbl">{label}</div>}
      <div className="num">{num}</div><div className={'dot' + dotFor(iso)} />
    </div>

  const strip = weekDays(today, offset).map(d => dayCell(d.iso, t(DAYS[d.dow]), d.day))

  const grid = monthGrid(today, offset)
  const monthCells = grid.days.map(d => dayCell(d.iso, null, d.day, d.out ? ' out' : ''))

  // A year is twelve months, each showing how many sessions it holds — a heatmap of 365
  // squares is what Stats is for, and does not survive a phone's width. Tapping a month
  // opens it, so the arrows and the drill-down agree on what "next" means.
  const monthCounts = yearMonths(today, offset).map(m => ({
    ...m, n: S.workouts.filter(w => w.d >= m.from && w.d <= m.to).length,
  }))
  const busiest = Math.max(1, ...monthCounts.map(m => m.n))
  const thisMonthKey = todayISO().slice(0, 7)

  const label = periodLabel(period, today, offset, t, dateLocale())

  const wThisWeek = S.workouts.filter(w => weekKey(w.d) === weekKey(todayISO())).length
  const plannedPerWeek = Object.keys(S.week).filter(k => S.week[k]).length
  const bwPoints = S.bodyweight.slice(-30).map(b => ({ t: b.t || new Date(b.d).getTime(), y: b.w, d: b.d }))

  // today's session shown right under the week strip
  const onToday = () => { if (S.active) nav('/workout'); else if (routine) startFlow(routine.id); else dayOverrideSheet(todayISO()) }

  return <div className="narrow">
    <div className="hdr">
      <div><h1>{user ? t('Hi {0}', user.name) : 'MyGymBro'}</h1><div className="sub">{today.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}</div></div>
      <button className="iconbtn" onClick={() => nav('/settings')} aria-label={t('Settings')}><Icon name="gear" /></button>
    </div>

    <div className="card">
      <div className="row between" style={{ marginBottom: 8 }}>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => step(-1)} aria-label={t('Previous')}><Icon name="chevronLeft" /></button>
        <button className="periodlbl" onClick={() => setOffset(0)} disabled={offset === 0}
          title={offset === 0 ? undefined : t('Back to today')}>{label}</button>
        <button className="iconbtn" style={{ width: 30, height: 30, fontSize: 15 }} onClick={() => step(1)} aria-label={t('Next')}><Icon name="chevronRight" /></button>
      </div>
      <Segmented className="seg-inline seg-period" options={PERIODS.map(p => ({ value: p, label: t(p === 'week' ? 'Week' : p === 'month' ? 'Month' : 'Year') }))}
        value={period} onChange={switchTo} />
      {period === 'week' && <div className="week">{strip}</div>}
      {period === 'month' && <>
        <div className="week mhead">{DAYS.slice(1).concat(DAYS[0]).map(d => <div key={d} className="lbl">{t(d)}</div>)}</div>
        <div className="mgrid">{monthCells}</div>
      </>}
      {period === 'year' && <div className="ygrid">
        {monthCounts.map(m => <button key={m.month}
          className={'ymon' + (m.n ? ' has' : '') + (`${m.year}-${String(m.month + 1).padStart(2, '0')}` === thisMonthKey ? ' today' : '')}
          style={{ '--fill': m.n / busiest }}
          aria-label={`${t(MONTHS_LONG[m.month])} ${m.year} — ${t(m.n === 1 ? '{0} workout total' : '{0} workouts total', m.n)}`}
          onClick={() => { setPeriod('month'); setOffset((m.year - today.getFullYear()) * 12 + m.month - today.getMonth()) }}>
          <span className="mn">{t(MONTHS[m.month])}</span>
          <span className="cnt">{m.n || '—'}</span>
        </button>)}
      </div>}
      <div className="today-row" onClick={onToday}>
        <div className="row" style={{ gap: 9, minWidth: 0 }}>
          <span className="lrow-i" style={{ background: S.active ? 'var(--orange)' : routine ? 'var(--acc)' : 'var(--surface-3)' }}>
            <Icon name={S.active ? 'timer' : routine ? glyphOf(routine.emoji) : 'moon'} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="lbl2">{t('Today')}</div>
            <div className="ttl">{S.active ? t('{0} — in progress', S.active.name) : routine ? routine.name : t('Rest day')}{todayOvr && routine ? ' · ' + t('rescheduled') : ''}</div>
          </div>
        </div>
        {S.active ? <span className="tag" style={{ color: 'var(--orange)', background: 'color-mix(in srgb,var(--orange) 16%,transparent)' }}>{t('Resume')}</span>
          : routine ? <span className="tag acc">{t('Start')}</span>
          : <Icon name="plus" className="chev" />}
      </div>
    </div>

    {!S.routines.length && !S.active && (
      <div className="card">
        <div className="row" style={{ gap: 10, marginBottom: 6 }}>
          <span className="lrow-i"><Icon name="sparkles" /></span>
          <div className="big" style={{ fontSize: 22 }}>{t('Welcome!')}</div>
        </div>
        <div className="muted small" style={{ marginBottom: 12 }}>{t('Set up your weekly routine to get going — or load a ready-made Push / Pull / Legs plan.')}</div>
        <Button variant="primary" icon="sparkles" onClick={loadStarterPlan}>{t('Load starter plan (PPL)')}</Button>
        <div style={{ height: 8 }} /><Button onClick={() => nav('/plan')}>{t('Build my own plan')}</Button>
      </div>
    )}

    <div className="card">
      <div className="row between" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>{t('Body weight')}</h2>
        <div className="row" style={{ gap: 8 }}>
          <Button size="sm" icon="target" style={S.targetW ? { color: 'var(--yellow)' } : undefined} onClick={goalSheet}>{S.targetW ? fmtNum(S.targetW) : t('Goal')}</Button>
          <Button size="sm" icon="plus" onClick={() => bwSheet()}>{t('Log')}</Button>
        </div>
      </div>
      {bw ? <>
        <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
          <div className="big">{fmtNum(bw.w)} <span className="muted" style={{ fontSize: '1rem' }}>{S.unit}</span></div>
          {/* only when it actually moved — an unchanged weight used to read as "− 0" */}
          {!!delta && (
            <span className="small row" style={{ gap: 2, fontWeight: 500, color: bwDeltaColor(delta, bw.w) }}>
              <Icon name={delta > 0 ? 'arrowUp' : 'arrowDown'} style={{ fontSize: 12 }} />
              {fmtNum(Math.abs(delta))}
            </span>
          )}
          <span className="dim small" style={{ marginLeft: 'auto' }}>{fmtDate(bw.d, true)}</span>
        </div>
        {S.targetW && (
          <div className="small row" style={{ color: 'var(--yellow)', marginTop: 4, gap: 5 }}>
            <Icon name="target" style={{ fontSize: 13 }} />
            <span>{t('Goal')} {fmtNum(S.targetW)} {S.unit} · {Math.abs(S.targetW - bw.w) < 0.05 ? t('reached!') : t(S.targetW > bw.w ? '{0} to gain' : '{0} to lose', fmtNum(Math.abs(S.targetW - bw.w)) + ' ' + S.unit)}</span>
          </div>
        )}
        <div className="chart" style={{ marginTop: 8 }}><LineChart points={bwPoints} h={130} unit={S.unit} goal={S.targetW} /></div>
      </> : <div className="muted small">{t("No entries yet — log your weight to start the curve. It's also asked before every workout.")}</div>}
    </div>

    <div className="card tappable" style={{ cursor: 'pointer' }} onClick={() => calendarSheet()}>
      <div className="row between">
        <div>
          <div className="row" style={{ gap: 7, fontSize: 22, fontWeight: 600, letterSpacing: '-.021em' }}>
            <Icon name="flame" style={{ color: 'var(--orange)' }} />
            {t('{0} week streak', streakWeeks(S))}
          </div>
          <div className="muted small" style={{ marginTop: 2 }}>{wThisWeek}{plannedPerWeek ? ' / ' + plannedPerWeek : ''} {t('this week')} · {t(S.workouts.length === 1 ? '{0} workout total' : '{0} workouts total', S.workouts.length)}</div>
        </div>
        <Icon name="calendar" className="chev" style={{ fontSize: 20 }} />
      </div>
    </div>
  </div>
}
