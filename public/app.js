const app = document.getElementById('app');

function consumeGrant() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const grant = fragment.get('grant');
  if (grant) sessionStorage.setItem('portalGrant', grant);
  if (location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
  return grant || sessionStorage.getItem('portalGrant') || '';
}

const portalGrant = consumeGrant();

function text(value) {
  return value == null ? '' : String(value);
}

function fmtDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function monthDay(dateString) {
  if (!dateString) return { month: 'TBD', day: '--' };
  
  // Normalize string format and extract date
  const cleanStr = String(dateString).replace(/[\u2010-\u2015]/g, '-').trim();
  const dateObj = new Date(cleanStr.includes('T') ? cleanStr : `${cleanStr}T00:00:00`);

  if (isNaN(dateObj.getTime())) {
    return { month: 'TBD', day: '--' };
  }

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    month: months[dateObj.getMonth()],
    day: String(dateObj.getDate())
  };
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = text(value);
    else if (key.startsWith('aria-')) node.setAttribute(key, value);
    else if (value !== false && value != null) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

function getUuid() {
  const match = location.pathname.match(/\/agent\/([^/]+)/);
  return match?.[1] || 'demo-platinum-partner';
}

function applyBrand(company) {
  const colors = {
    '--gold': company.brand.primary,
    '--gold-dark': company.brand.accentText,
    '--ink': company.brand.ink,
    '--muted': company.brand.muted,
    '--surface': company.brand.surface,
    '--paper': company.brand.background,
    '--line': company.brand.border,
    '--green': company.brand.success,
    '--blue': company.brand.focus
  };
  for (const [property, value] of Object.entries(colors)) document.documentElement.style.setProperty(property, value);
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute('content', company.brand.primary);
}

function parseSubcontractorEntries(rawString) {
  if (!rawString) return [];
  // Split on semicolons first, then fallback to commas if needed
  const items = rawString.split(/;|\n/).map(s => s.trim()).filter(Boolean);
  
  return items.map(item => {
    const colonIdx = item.indexOf(':');
    if (colonIdx === -1) {
      return { service: 'Subcontractor', scheduleStr: item };
    }
    const service = item.slice(0, colonIdx).trim();
    const scheduleStr = item.slice(colonIdx + 1).trim();
    return { service, scheduleStr };
  });
}

// Categorize inspections into Upcoming, In Progress, and Completed
function categorizeInspections(inspections) {
  const now = new Date();
  const upcoming = [];
  const inProgress = [];
  const completed = [];

  for (const insp of inspections || []) {
    if (insp.finished) {
      completed.push(insp);
      continue;
    }

    const raw = insp.rawDatetime || insp.date;
    const cleanStr = raw ? String(raw).replace(/[\u2010-\u2015]/g, '-').trim() : '';
    const startDate = cleanStr ? new Date(cleanStr.includes('T') ? cleanStr : `${cleanStr}T00:00:00`) : null;

    if (!startDate || isNaN(startDate.getTime())) {
      upcoming.push(insp);
      continue;
    }

    const endDate = new Date(startDate.getTime() + (Number(insp.durationHours) || 2) * 3600000);

    if (now >= startDate && now <= endDate) {
      inProgress.push(insp);
    } else if (now < startDate) {
      upcoming.push(insp);
    } else {
      inProgress.push(insp);
    }
  }

  return { upcoming, inProgress, completed };
}

// Helper to format start time + duration into an explicit time window
function formatTimeWindow(startIso, durationHours) {
  if (!startIso) return 'Scheduled';
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return 'Scheduled';

  const durationMs = (Number(durationHours) || 2) * 3600000;
  const end = new Date(start.getTime() + durationMs);

  const formatOptions = { hour: 'numeric', minute: '2-digit', hour12: true };
  const startTimeStr = start.toLocaleTimeString('en-US', formatOptions);
  const endTimeStr = end.toLocaleTimeString('en-US', formatOptions);

  return `${startTimeStr} - ${endTimeStr}`;
}

function renderDashboard(data) {
  const { company, agent, stats, tier, inspections } = data;
  applyBrand(company);
  document.title = `${agent.firstName} ${agent.lastName} | ${company.appName}`;
  app.replaceChildren();

  // Topbar
  app.append(
    el('header', { class: 'topbar' }, [
      el('div', { class: 'brand-lockup' }, [
        el('div', { class: 'brand', text: company.name }),
        el('p', { class: 'company-tagline', text: company.tagline })
      ]),
      el('div', { class: 'badge', text: company.appName })
    ])
  );

  // Hero Section
  const avatar = el('img', {
    class: 'avatar',
    src: agent.photoUrl || '/assets/M300.png',
    alt: `${agent.firstName} ${agent.lastName}`
  });
  app.append(
    el('section', { class: 'hero' }, [
      avatar,
      el('h1', { class: 'agent-name', text: `${agent.firstName} ${agent.lastName}` }),
      el('p', { class: 'agency', text: agent.agency || 'Real estate partner' })
    ])
  );

  // Relationship Snapshot Metrics
  app.append(
    el('section', { class: 'section' }, [
      el('h2', { text: 'Relationship Snapshot' }),
      el('div', { class: 'metrics' }, [
        el('div', { class: 'metric' }, [el('strong', { text: stats.totalInspections }), el('span', { text: 'Total' })]),
        el('div', { class: 'metric' }, [el('strong', { text: stats.buyingInspections }), el('span', { text: 'Buying' })]),
        el('div', { class: 'metric' }, [el('strong', { text: stats.sellingInspections }), el('span', { text: 'Selling' })])
      ])
    ])
  );

  const { upcoming, inProgress, completed } = categorizeInspections(inspections);

  function buildTimeline(list, stageClass, showDetails = false) {
  const timelineEl = el('div', { class: 'timeline' });
  for (const inspection of list) {
    const date = monthDay(inspection.rawDatetime || inspection.date);
    
    const dateBadge = el('div', { class: `date badge-date ${stageClass}` }, [
      document.createTextNode(date.month),
      el('span', { text: date.day })
    ]);

    const detailsEl = el('div', { class: 'inspection-details' }, [
      el('p', { class: 'inspection-title', text: inspection.location || inspection.address || 'Location withheld' }),
      el('p', { class: 'inspection-meta', text: inspection.services || '' })
    ]);

    if (showDetails) {
      const timeWindow = formatTimeWindow(inspection.rawDatetime, inspection.durationHours);

      const timelineItems = [
        el('div', { class: 'timeline-row' }, [
          el('span', { class: 'dot main-dot' }),
          el('span', { class: 'timeline-label', text: 'Main Inspection: ' }),
          el('span', { class: 'timeline-val', text: timeWindow })
        ])
      ];

      const subs = parseSubcontractorEntries(inspection.subcontractorSchedule);
      for (const sub of subs) {
        const valLower = sub.scheduleStr.toLowerCase();
        let statusClass = 'status-default';
        
        if (valLower.includes('pending')) {
          statusClass = 'is-pending';
        } else if (valLower.includes('complete')) {
          statusClass = 'is-complete';
        }

        timelineItems.push(
          el('div', { class: 'timeline-row' }, [
            el('span', { class: 'dot sub-dot' }),
            el('span', { class: 'timeline-label', text: `${sub.service}: ` }),
            el('span', { class: `timeline-val ${statusClass}`, text: sub.scheduleStr })
          ])
        );
      }

      detailsEl.append(el('div', { class: 'timeline-sub-block' }, timelineItems));
    }

    timelineEl.append(
      el('article', { class: 'timeline-item' }, [
        dateBadge,
        detailsEl
      ])
    );
  }
  return timelineEl;
}

  // 1. IN PROGRESS SECTION (Only if items exist)
  if (inProgress.length > 0) {
    app.append(
      el('section', { class: 'section' }, [
        el('h2', { text: 'In Progress' }),
        buildTimeline(inProgress, 'badge-in-progress', true)
      ])
    );
  }

  // 2. UPCOMING INSPECTIONS SECTION (Only if items exist)
  if (upcoming.length > 0) {
    app.append(
      el('section', { class: 'section' }, [
        el('h2', { text: 'Upcoming Inspections' }),
        buildTimeline(upcoming, 'badge-upcoming', true)
      ])
    );
  }

  // 3. COMPLETED INSPECTIONS SECTION (Only if items exist)
  if (completed.length > 0) {
    app.append(
      el('section', { class: 'section' }, [
        el('h2', { text: 'Completed Inspections' }),
        buildTimeline(completed, 'badge-completed', false)
      ])
    );
  }

  // 4. GLOBAL EMPTY STATE (Only if no inspections exist across all 3 stages)
  if (inProgress.length === 0 && upcoming.length === 0 && completed.length === 0) {
    app.append(
      el('section', { class: 'section' }, [
        el('div', { class: 'empty-state' }, [
          el('p', { text: 'No inspections scheduled yet.' }),
          el('a', {
            class: 'action-link',
            href: company.bookingUrl,
            target: '_blank',
            rel: 'noopener',
            text: 'Schedule an Inspection'
          })
        ])
      ])
    );
  }

  // Footer
  app.append(
    el('footer', { class: 'footer' }, [
      document.createTextNode(`${company.license} | ${company.website}`)
    ])
  );
}

async function load() {
  try {
    const requestOptions = { cache: 'no-store', headers: {} };
    if (portalGrant) requestOptions.headers.Authorization = `Bearer ${portalGrant}`;
    const response = await fetch(`/api/agent/${encodeURIComponent(getUuid())}`, requestOptions);
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    renderDashboard(await response.json());
  } catch (error) {
    app.replaceChildren(
      el('section', { class: 'error' }, [
        el('h1', { text: 'Portal unavailable' }),
        el('p', { text: error.message })
      ])
    );
  }
}

load();
