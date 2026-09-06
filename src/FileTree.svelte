<script>
  export let tree;
  export let onFile;

  const iconClass = (name) =>
    /\.(h|hpp|hxx)$/.test(name) ? 'h'
    : /\.(cpp|cc|cxx)$/.test(name) ? 'cpp'
    : /\.(py|js|ts|json|qss|txt|md|mjs)$/.test(name) ? 'other'
    : 'other';
  const iconLetter = (cls) => cls === 'h' ? 'h' : cls === 'cpp' ? 'C' : '·';
</script>

{#each tree as node}
  {#if node.dir}
    <div>
      <button class="fdir" onclick={() => (node.open = !node.open)}>
        <svg class="fd-ico {node.open ? 'open' : ''}" width="13" height="13" viewBox="0 0 14 14">
          <path d="M1 3.5c0-.8.7-1.5 1.5-1.5h2.2l1.4 1.4h5.4c.8 0 1.5.7 1.5 1.5v5.1c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5V3.5z"
                fill="currentColor"/>
        </svg>
        {node.name}
        <span class="fcount">{node.children.length}</span>
      </button>
      {#if node.open}
        <div class="indent">
          <svelte:self tree={node.children} onFile={onFile} />
        </div>
      {/if}
    </div>
  {:else}
    <button class="ffile" onclick={() => onFile(node.path)}>
      <span class="fico {iconClass(node.name)}">{iconLetter(iconClass(node.name))}</span>
      {node.name}
    </button>
  {/if}
{/each}

<style>
  .fdir {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
    color: #4A4740;
    padding: 3px 6px;
    border-radius: 4px;
    text-align: left;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .fdir:hover { background: #F0EEE6; }
  .fd-ico { color: #C9C2B4; flex-shrink: 0; }
  .fd-ico.open { color: #D97757; }
  .fcount { margin-left: auto; font-size: 10px; color: #9A968A; }
  .ffile {
    border: none;
    background: transparent;
    cursor: pointer;
    font-size: 11.5px;
    font-family: 'Consolas', monospace;
    color: #1F1E1D;
    padding: 3px 6px 3px 20px;
    border-radius: 4px;
    text-align: left;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .ffile:hover { background: #FDF0E7; color: #D97757; }
  .fico {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    font-size: 9px;
    font-weight: 700;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    flex-shrink: 0;
    font-family: 'Segoe UI', sans-serif;
  }
  .fico.h { background: #3E7D4F; }      /* 头文件：绿 */
  .fico.cpp { background: #D97757; }    /* 实现文件：赤陶 */
  .fico.other { background: #9A968A; }  /* 其他：暖灰 */
  .indent { margin-left: 14px; }
</style>
