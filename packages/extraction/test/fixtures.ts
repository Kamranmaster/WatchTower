/** Realistic page shapes for extraction tests. */

const chrome = (body: string) => `<!doctype html><html><head><title>Careers</title>
<script>window.__STATE__ = {"nonce":"${Math.random()}"}</script><style>.x{color:red}</style></head>
<body>
  <header><a href="/">Acme</a><nav><a href="/about">About us</a><a href="/blog">Our blog</a><a href="/careers">Careers at Acme</a></nav></header>
  <div class="cookie-banner">We use cookies to improve your experience. <button>Accept all cookies</button></div>
  <main>${body}</main>
  <footer><a href="/privacy">Privacy policy</a><a href="/terms">Terms of service</a><a href="/contact">Contact the team</a></footer>
</body></html>`;

export interface Job {
  title: string;
  slug: string;
  location: string;
  posted?: string;
}

export const JOBS: Job[] = [
  { title: 'Software Engineer', slug: 'software-engineer', location: 'Bangalore, India', posted: '2 days ago' },
  { title: 'Data Analyst', slug: 'data-analyst', location: 'Remote', posted: '5 days ago' },
  { title: 'Product Designer', slug: 'product-designer', location: 'Berlin, Germany', posted: '1 week ago' },
];

/** The common "list of cards with links" careers page. */
export function cardsPage(jobs: Job[], extraQuery = '') {
  return chrome(`<h1>Open positions</h1><div class="jobs">${jobs
    .map(
      (j) => `<div class="job-card">
        <h3 class="job-title"><a href="/jobs/${j.slug}${extraQuery}">${j.title}</a></h3>
        <span class="job-location">${j.location}</span>
        ${j.posted ? `<span class="posted">Posted ${j.posted}</span>` : ''}
      </div>`,
    )
    .join('\n')}</div>`);
}

/** A plain <ul> of links. */
export function listPage(titles: string[]) {
  return chrome(`<h2>Jobs</h2><ul>${titles.map((t) => `<li><a href="/jobs?id=${encodeURIComponent(t)}">${t}</a></li>`).join('')}</ul>`);
}

/** A table without links: identity has to come from titles. */
export function tablePage(rows: [string, string][]) {
  return chrome(
    `<table><thead><tr><th>Role</th><th>City</th></tr></thead><tbody>${rows
      .map(([role, city]) => `<tr><td>${role}</td><td>${city}</td></tr>`)
      .join('')}</tbody></table>`,
  );
}

export function jsonLdJobsPage(jobs: { title: string; id: string; city: string }[]) {
  const data = {
    '@context': 'https://schema.org',
    '@graph': jobs.map((j) => ({
      '@type': 'JobPosting',
      title: j.title,
      identifier: { '@type': 'PropertyValue', value: j.id },
      url: `https://careers.example.com/jobs/${j.id}?utm_source=feed`,
      jobLocation: { '@type': 'Place', address: { addressLocality: j.city, addressCountry: 'IN' } },
      employmentType: 'INTERN',
      hiringOrganization: { name: 'Acme' },
    })),
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(data)}</script></head><body><div id="root"></div></body></html>`;
}

export function productPage(availability: 'InStock' | 'OutOfStock', price: string) {
  const data = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: 'PS5 Pro',
    sku: 'PS5-PRO-1TB',
    offers: { '@type': 'Offer', price, priceCurrency: 'INR', availability: `https://schema.org/${availability}`, url: '/ps5-pro' },
  };
  return chrome(`<script type="application/ld+json">${JSON.stringify(data)}</script><h1>PS5 Pro</h1><p>The most powerful PlayStation console yet.</p>`);
}

export function articlePage(paragraphs: string[], updatedAt = '10:42 AM') {
  return chrome(`<article><h1>Release notes</h1><p class="meta">Last updated ${updatedAt}</p>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</article>`);
}
