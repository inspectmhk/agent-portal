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

function monthDay(value) {
  const date = new Date(`${value}T00:00:00`);
  return {
    month: new Intl.DateTimeFormat('en-US', { month: 'short' }).format(date),
    day: new Intl.DateTimeFormat('en-US', { day: '2-digit' }).format(date)
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

function renderDashboard(data) {
  const { company, agent, stats, tier, inspections } = data;
  applyBrand(company);
  document.title = `${agent.firstName} ${agent.lastName} | ${company.appName}`;
  app.replaceChildren();

  app.append(
    el('header', { class: 'topbar' }, [
      el('div', { class: 'brand-lockup' }, [
        el('div', { class: 'brand', text: company.name }),
        el('p', { class: 'company-tagline', text: company.tagline })
      ]),
      el('div', { class: 'badge', text: company.appName })
    ])
  );

  const avatar = el('img', {
    class: 'avatar',
    src: agent.photoUrl || '/assets/mock-agent.svg',
    alt: `${agent.firstName} ${agent.lastName}`
  });
  app.append(
    el('section', { class: 'hero' }, [
      avatar,
      el('h1', { class: 'agent-name', text: `${agent.firstName} ${agent.lastName}` }),
      el('p', { class: 'agency', text: agent.agency || 'Real estate partner' }),
      el('div', { class: 'tier' }, [
        el('span', { class: 'tier-dot', 'aria-hidden': 'true' }),
        document.createTextNode(tier.label || 'Partner')
      ])
    ])
  );

  app.append(
    el('section', { class: 'section' }, [
      el('h2', { text: 'Schedule Next Inspection' }),
      el('div', { class: 'actions' }, [
        el('a', { class: 'action', href: company.bookingUrl, target: '_blank', rel: 'noopener' }, [
          el('strong', { text: 'Online' }),
          el('span', { text: company.bookingUrl })
        ]),
        el('a', { class: 'action', href: `tel:${company.phone.replace(/[^\d+]/g, '')}` }, [
          el('strong', { text: 'Call or Text' }),
          el('span', { text: company.phone })
        ]),
        // el('a', { class: 'action', href: company.whatsappUrl, target: '_blank', rel: 'noopener' }, [
        //   el('strong', { text: 'Message' }),
        //   el('span', { text: 'Start a quick conversation' })
        // ]),
        // el('a', { class: 'action', href: company.website, target: '_blank', rel: 'noopener' }, [
        //   el('strong', { text: 'Website' }),
        //   el('span', { text: 'View services and resources' })
        // ])
      ])
    ])
  );

  // app.append(
  //   el('section', { class: 'section' }, [
  //     el('h2', { text: 'Relationship Snapshot' }),
  //     el('div', { class: 'metrics' }, [
  //       el('div', { class: 'metric' }, [el('strong', { text: stats.totalInspections }), el('span', { text: 'Total' })]),
  //       el('div', { class: 'metric' }, [el('strong', { text: stats.buyingInspections }), el('span', { text: 'Buying' })]),
  //       el('div', { class: 'metric' }, [el('strong', { text: stats.sellingInspections }), el('span', { text: 'Selling' })])
  //     ])
  //   ])
  // );

  // app.append(
  //   el('section', { class: 'section' }, [
  //     el('h2', { text: 'Partnership' }),
  //     el('div', { class: 'partnership' }, [
  //       el('div', { class: 'partnership-row' }, [
  //         el('span', { text: fmtDate(stats.firstInspection) || 'Start' }),
  //         el('span', { text: fmtDate(stats.lastInspection) || 'Present' })
  //       ]),
  //       el('div', { class: 'bar', 'aria-hidden': 'true' }, [el('span')]),
  //       el('p', {
  //         class: 'privacy-note',
  //         text: portalModeCopy.modeNotice(data.meta?.mode)
  //       })
  //     ])
  //   ])
  // );

  const timeline = el('div', { class: 'timeline' });
  for (const inspection of inspections) {
    const date = monthDay(inspection.date);
    timeline.append(
      el('article', { class: 'timeline-item' }, [
        el('div', { class: 'date' }, [
          document.createTextNode(date.month),
          el('span', { text: date.day })
        ]),
        el('div', {}, [
          el('p', { class: 'inspection-title', text: inspection.location || inspection.address }),
          el('p', {
            class: 'inspection-meta',
            text: `${inspection.services} | ${inspection.inspector} | ${inspection.status}`
          })
        ])
      ])
    );
  }

  app.append(
    el('section', { class: 'section' }, [
      el('h2', { text: 'Inspection History' }),
      timeline
    ])
  );

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
