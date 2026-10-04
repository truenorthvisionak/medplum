// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Badge } from '@mantine/core';
import type { JSX } from 'react';

/** Lifecycle of an autosaved form: edits mark it dirty, a debounced save follows. */
export type SaveState = 'loading' | 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * Autosave status indicator shared by the autosaving cards (eye exam, assessment).
 * @param props - The component props.
 * @param props.state - Current autosave state.
 * @returns A colored status badge, or null before the first edit.
 */
export function SaveBadge(props: { readonly state: SaveState }): JSX.Element | null {
  const { state } = props;
  if (state === 'saving' || state === 'dirty') {
    return (
      <Badge variant="light" color="yellow">
        Saving…
      </Badge>
    );
  }
  if (state === 'error') {
    return (
      <Badge variant="light" color="red">
        Save failed — retrying on next edit
      </Badge>
    );
  }
  if (state === 'saved') {
    return (
      <Badge variant="light" color="green">
        All changes saved
      </Badge>
    );
  }
  return null;
}
