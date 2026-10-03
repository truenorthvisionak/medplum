// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Anchor, Group, Loader, Text } from '@mantine/core';
import type { Attachment } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';

export interface PdfAttachmentProps {
  readonly attachment: Attachment;
  readonly height?: number;
}

/**
 * Renders a PDF attachment inline. The Medplum API sends
 * `frame-ancestors 'none'`, so framing the binary URL directly is blocked;
 * instead the PDF is downloaded with the authenticated client and framed as a
 * same-origin blob URL.
 */
export function PdfAttachment(props: PdfAttachmentProps): JSX.Element {
  const { attachment, height = 700 } = props;
  const medplum = useMedplum();
  const [blobUrl, setBlobUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let created: string | undefined;
    if (attachment.url) {
      medplum
        .download(attachment.url)
        .then((blob) => {
          if (active) {
            created = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }));
            setBlobUrl(created);
          }
        })
        .catch((err) => active && setError(String(err)));
    }
    return () => {
      active = false;
      if (created) {
        URL.revokeObjectURL(created);
      }
    };
  }, [medplum, attachment.url]);

  if (error) {
    return (
      <Text c="red" size="sm">
        Could not load PDF: {error}
      </Text>
    );
  }
  if (!blobUrl) {
    return <Loader size="sm" />;
  }
  return (
    <>
      <Group gap="md" mb={4}>
        <Anchor href={blobUrl} target="_blank" size="sm">
          Open in new tab
        </Anchor>
        <Anchor href={blobUrl} download={attachment.title ?? 'document.pdf'} size="sm">
          Download
        </Anchor>
      </Group>
      <iframe
        title={attachment.title ?? 'PDF document'}
        src={blobUrl}
        style={{ width: '100%', height, border: '1px solid var(--mantine-color-gray-3)', borderRadius: 4 }}
      />
    </>
  );
}
