<template>
  <div class="annotation-thread">
    <div
      v-for="message in rows"
      v-bind:key="message.messageId"
      class="annotation-message"
      v-bind:class="message.author"
    >
      <div class="annotation-message-meta">
        <AvatarRoot
          class="annotation-avatar"
          v-bind:class="message.glyph"
        >
          <AvatarFallback class="annotation-avatar-fallback">
            <cds-icon
              v-bind:shape="message.glyph === 'sparkle' ? 'wand' : 'user'"
              role="presentation"
            ></cds-icon>
          </AvatarFallback>
        </AvatarRoot>
        <span class="annotation-message-author">{{ message.authorLabel }}</span>
        <span class="annotation-message-time annotation-muted">{{ message.relativeTime }}</span>
        <span
          v-if="message.messageId === actedMessageId"
          class="annotation-lifecycle-pill acted"
        >{{ trans("Acted") }}</span>
      </div>
      <div
        v-annotation-markdown="message.text"
        class="annotation-message-text"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        AnnotationThread
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The multi-turn conversation (S6): owner-first,
 *                  alternating. The owner's first message IS the
 *                  instruction — there is no separate title or instruction
 *                  field rendered here, only the thread. Each message is an
 *                  author row (avatar glyph, name, relative time against
 *                  the host's minute clock) over its body.
 *
 * END HEADER
 */

import { trans } from "@common/i18n-renderer";
import type { AnnotationMessage } from "@dts/common/annotation-domain";
import type { DateTime } from "luxon";
import { AvatarFallback, AvatarRoot } from "reka-ui";
import { computed } from "vue";
import { threadMessageView } from "../sidebar/annotations/annotation-presentation";
import { vAnnotationMarkdown } from "./annotation-markdown";

const props = defineProps<{
  messages: AnnotationMessage[];
  now: DateTime;
  actedMessageId?: string;
}>();

const labels = { owner: trans("You"), agent: trans("AI"), justNow: trans("Just now") };

const rows = computed(() =>
  props.messages.map((message) => threadMessageView(message, props.now, labels)),
);
</script>

<style lang="less">
body {
  .annotation-thread {
    display: flex;
    flex-direction: column;
    gap: var(--annotation-gap);
    color: var(--annotation-text);
    font-size: var(--annotation-font-size);
  }

  .annotation-message {
    display: flex;
    flex-direction: column;
    gap: 4px;

    .annotation-message-meta {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .annotation-message-author {
      font-weight: 600;
    }

    .annotation-message-text {
      margin: 0 0 0 26px;
      white-space: pre-wrap;

      > :first-child {
        margin-top: 0;
      }

      > :last-child {
        margin-bottom: 0;
      }
    }
  }

  .annotation-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid var(--annotation-border);
    color: var(--annotation-text-muted);

    &.sparkle {
      border-color: var(--annotation-agent);
      color: var(--annotation-agent);
    }

    .annotation-avatar-fallback {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    cds-icon {
      width: 12px;
      height: 12px;
    }
  }
}
</style>
