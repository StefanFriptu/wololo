<script lang="ts">
  import { page } from '$app/state';
  import Icon from '#lib/components/Icon.svelte';
  import { isActiveChild, NAV, sectionOf } from '#lib/nav.ts';
  import { href } from '#lib/paths.ts';
  import { runtimeConfig } from '#lib/runtime.ts';

  let { open = false, onnavigate }: { open?: boolean; onnavigate?: () => void } = $props();

  const urlBase = runtimeConfig().urlBase;
  const pathname = $derived(page.url.pathname.slice(urlBase.length) || '/');
  const section = $derived(sectionOf(pathname));
</script>

<nav id="sidebar" class="sidebar" class:open aria-label="Main">
  <ul>
    {#each NAV as item (item.href)}
      {@const active = sectionOf(item.href) === section}
      <li>
        <a href={href(item.href)} class="top" class:active onclick={onnavigate}>
          <Icon name={item.icon} />
          <span>{item.label}</span>
        </a>
        {#if item.children && active}
          <ul class="children">
            {#each item.children as child (child.href)}
              {@const current = isActiveChild(pathname, child.href, item.children)}
              <li>
                <a
                  href={href(child.href)}
                  class:active={current}
                  aria-current={current ? 'page' : undefined}
                  onclick={onnavigate}>{child.label}</a
                >
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ul>
</nav>

<style>
  .sidebar {
    background: var(--sidebar-bg);
    color: var(--sidebar-text);
    width: var(--sidebar-width);
    flex-shrink: 0;
    overflow-y: auto;
    position: sticky;
    top: var(--header-height);
    height: calc(100vh - var(--header-height));
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  a {
    color: inherit;
    text-decoration: none;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .top {
    padding: 0.75rem 1.25rem;
    border-left: 3px solid transparent;
  }
  .top:hover,
  .children a:hover {
    background: var(--sidebar-hover);
  }
  .top.active {
    color: var(--sidebar-active);
    border-left-color: var(--accent);
    font-weight: 600;
  }
  .children a {
    padding: 0.45rem 1.25rem 0.45rem 3.15rem;
    font-size: 0.93em;
  }
  .children a.active {
    color: #5fd6c4;
    font-weight: 600;
  }
  a:focus-visible {
    outline-offset: -2px;
  }
  @media (max-width: 768px) {
    .sidebar {
      position: fixed;
      top: var(--header-height);
      bottom: 0;
      left: 0;
      height: auto;
      z-index: 20;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
      visibility: hidden;
    }
    .sidebar.open {
      transform: none;
      visibility: visible;
    }
  }
</style>
