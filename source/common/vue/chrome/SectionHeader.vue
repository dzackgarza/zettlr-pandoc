<template>
  <AccordionHeader
    as="div"
    class="chrome-section-header"
  >
    <AccordionTrigger class="chrome-section-trigger">
      <cds-icon
        class="chrome-section-chevron"
        shape="angle"
        direction="right"
        role="presentation"
      ></cds-icon>
      <span class="chrome-section-label">{{ props.label }}</span>
      <span
        v-if="props.count !== undefined"
        class="chrome-section-count"
      >{{ props.count }}</span>
    </AccordionTrigger>
    <span
      v-if="slots.actions !== undefined"
      class="chrome-section-actions"
    >
      <slot name="actions"></slot>
    </span>
  </AccordionHeader>
</template>

<script setup lang="ts">
/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        SectionHeader
 * CVM-Role:        View
 * Maintainer:      D. Zack Garza
 * License:         GNU GPL v3
 *
 * Description:     The one section header of the main window's chrome: a
 *                  small uppercase label with a collapse chevron, an optional
 *                  count, and optional trailing actions on the same row. It is
 *                  an accordion trigger, so it must sit inside an
 *                  AccordionItem; reka-ui owns the toggle, the focus movement
 *                  between headers, and the ARIA wiring.
 *
 * END HEADER
 */

import { AccordionHeader, AccordionTrigger } from 'reka-ui'
import { useSlots } from 'vue'

const props = defineProps<{
  label: string
  count?: number
}>()

const slots = useSlots()
</script>

<style lang="less">
.chrome-section-header {
  display: flex;
  align-items: center;
  min-height: var(--chrome-section-height);
  padding: 0 var(--chrome-inset) 0 6px;
  box-sizing: border-box;

  .chrome-section-trigger {
    display: flex;
    flex: 1 1 auto;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: var(--chrome-section-height);
    margin: 0;
    padding: 0;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--chrome-text-muted);
    font: inherit;
    font-size: var(--chrome-section-font-size);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;

    &:focus-visible {
      outline: 2px solid var(--chrome-row-accent);
      outline-offset: -2px;
    }
  }

  .chrome-section-chevron {
    width: 12px;
    height: 12px;
    flex: 0 0 auto;
    transition: transform 0.15s ease;
  }

  // cds-icon's own direction="right" is a 90° host rotation; "down" is 180°.
  .chrome-section-trigger[data-state="open"] .chrome-section-chevron {
    transform: rotate(180deg);
  }

  .chrome-section-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chrome-section-count {
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
  }

  .chrome-section-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 2px;

    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--chrome-text-muted);
      cursor: pointer;

      &:hover {
        background-color: var(--chrome-row-hover-bg);
        color: var(--chrome-text);
      }

      cds-icon {
        width: 14px;
        height: 14px;
      }
    }
  }
}
</style>
