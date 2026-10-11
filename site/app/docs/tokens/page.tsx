import type { Metadata } from 'next';

import { DocPage, docsMetadata } from '@/components/doc-page';
import { MarkdownBlocks } from '@/components/markdown-blocks';
import { docs } from '@/lib/data';

export const metadata: Metadata = docsMetadata('/docs/tokens');

export default function TokensPage() {
  return (
    <DocPage href="/docs/tokens" file="docs/tokens.md">
      <MarkdownBlocks markdown={docs.tokens} />
    </DocPage>
  );
}
