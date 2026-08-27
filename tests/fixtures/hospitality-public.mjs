const detailPathByProvider = Object.freeze({
  oysterlink: "/job-posting/bartender-nyc/",
  hcareers: "/jobs/4364335-bartender",
  hospitalityonline: "/jobs/4364579-bartender",
  ihirehospitality: "/jobs/view/531949726",
});

const hostByProvider = Object.freeze({
  oysterlink: "oysterlink.com",
  hcareers: "www.hcareers.com",
  hospitalityonline: "www.hospitalityonline.com",
  ihirehospitality: "www.ihirehospitality.com",
});

export const listUrlByProvider = Object.freeze({
  oysterlink: "https://oysterlink.com/jobs/bartender/new-york-ny/",
  hcareers: "https://www.hcareers.com/jobs?what=Bartender&where=New+York%2C+NY",
  hospitalityonline: "https://www.hospitalityonline.com/jobs?what=Bartender&where=New+York%2C+NY",
  ihirehospitality: "https://www.ihirehospitality.com/t-hospitality-s-new-york-jobs.html",
});

export const detailUrlByProvider = Object.freeze(
  Object.fromEntries(
    Object.entries(detailPathByProvider).map(([provider, path]) => [
      provider,
      `https://${hostByProvider[provider]}${path}`,
    ])
  )
);

export const listHtmlByProvider = Object.freeze(
  Object.fromEntries(
    Object.entries(detailPathByProvider).map(([provider, path]) => [
      provider,
      `<!doctype html><html><body><a href="${path}">Bartender</a></body></html>`,
    ])
  )
);

function structuredPosting({
  title,
  company,
  city,
  region,
  datePosted,
  min,
  max,
  unitText,
  structuredSalary = true,
}) {
  const unit = unitText.toLowerCase();
  return `<!doctype html><html><body><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title,
    description: `<p>Serve guests in a high-volume New York bar.</p><p>Prepare drinks, handle payments, and keep the bar clean.</p><p>Compensation: $${min}.00 to $${max}.00 per ${unit}.</p>`,
    datePosted,
    validThrough: "2027-12-31T23:59:59Z",
    hiringOrganization: { "@type": "Organization", name: company },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: city,
        addressRegion: region,
        addressCountry: "US",
      },
    },
    ...(structuredSalary
      ? {
          baseSalary: {
            "@type": "MonetaryAmount",
            currency: "USD",
            value: { "@type": "QuantitativeValue", minValue: min, maxValue: max, unitText },
          },
        }
      : {}),
  })}</script></body></html>`;
}

export const detailHtmlByProvider = Object.freeze({
  oysterlink: structuredPosting({
    title: "Bartender",
    company: "Oyster Hotel",
    city: "New York",
    region: "NY",
    datePosted: "2026-08-20",
    min: 18,
    max: 24,
    unitText: "HOUR",
  }),
  hcareers: structuredPosting({
    title: "Rooftop Bartender",
    company: "Hcareers Hotel",
    city: "New York",
    region: "NY",
    datePosted: "2026-08-21",
    min: 20,
    max: 28,
    unitText: "HOUR",
    structuredSalary: false,
  }),
  hospitalityonline: structuredPosting({
    title: "Bartender",
    company: "Hospitality Online Hotel",
    city: "New York",
    region: "NY",
    datePosted: "2026-08-22",
    min: 21,
    max: 29,
    unitText: "HOUR",
    structuredSalary: false,
  })
    .replace("Compensation: $21.00 to $29.00 per hour.", "Competitive compensation.")
    .replace("<body>", "<body><p>Compensation: $21.00 to $29.00 per hour.</p>"),
  ihirehospitality: structuredPosting({
    title: "Food and Beverage Supervisor",
    company: "iHire Hotel",
    city: "New York",
    region: "NY",
    datePosted: "2026-08-23",
    min: 60000,
    max: 70000,
    unitText: "YEAR",
  }),
});
