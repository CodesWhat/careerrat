import type { Page } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import { docs } from "../../.source/server";

export const source = loader(docs.toFumadocsSource(), {
  baseUrl: "/",
});

type DocsPageData = (typeof docs.docs)[number];

export function getDocsPage(slugs?: string[]) {
  return source.getPage(slugs) as Page<string | undefined, DocsPageData> | undefined;
}
