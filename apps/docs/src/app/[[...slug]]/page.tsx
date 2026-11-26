import defaultMdxComponents from "fumadocs-ui/mdx";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/page";
import { notFound } from "next/navigation";
import { JsonLd } from "@/components/JsonLd";
import { getDocsPage, source } from "@/lib/source";

const ORIGIN = "https://careerrat.com";

function pageUrl(slugs: string[] = []) {
  return `${ORIGIN}/docs/${slugs.length ? `${slugs.join("/")}/` : ""}`;
}

function folderTitle(segment: string) {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function docStructuredData(slugs: string[], title: string, description?: string) {
  const crumbs = [{ name: "Docs", url: pageUrl() }];
  slugs.forEach((segment, index) => {
    const prefix = slugs.slice(0, index + 1);
    const isPage = index === slugs.length - 1;
    const ancestor = isPage ? undefined : getDocsPage(prefix);
    crumbs.push({
      name: isPage ? title : (ancestor?.data.title ?? folderTitle(segment)),
      url: pageUrl(prefix),
    });
  });
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: title,
        ...(description ? { description } : {}),
        url: pageUrl(slugs),
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", name: "CareerRat", url: `${ORIGIN}/` },
        publisher: {
          "@type": "Organization",
          name: "CodesWhat",
          url: "https://codeswhat.com",
        },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((crumb, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: crumb.name,
          item: crumb.url,
        })),
      },
    ],
  };
}

export default async function Page(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = getDocsPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd
        data={docStructuredData(params.slug ?? [], page.data.title, page.data.description)}
      />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={defaultMdxComponents} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const params = await props.params;
  const page = getDocsPage(params.slug);
  if (!page) notFound();

  const title = page.data.title;
  const description = page.data.description;
  // Absolute URLs: Next doesn't add the /docs basePath to metadata URLs, so
  // relative values would resolve against the bare origin.
  const url = pageUrl(params.slug);
  const image = {
    url: `${ORIGIN}/opengraph-image.png`,
    width: 1200,
    height: 630,
    alt: "CareerRat: Your AI CLI, working your job search.",
  };

  return {
    title: params.slug?.length ? title : { absolute: title },
    description,
    alternates: { canonical: url },
    ...(params.slug?.join("/") === "getting-started/dashboard"
      ? { robots: { index: false, follow: true } }
      : {}),
    openGraph: {
      title,
      description,
      url,
      siteName: "CareerRat Docs",
      type: "article",
      images: [image],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
  };
}
