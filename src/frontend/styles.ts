export const css = `
.pf-toast { position:fixed; z-index:1200; box-sizing:border-box; width:max-content; max-width:min(360px,calc(100vw - 16px)); padding:10px 14px; border-radius:8px; background:var(--dsw-alias-bg-layer-1,Canvas); color:var(--dsw-alias-label-primary,CanvasText); border:1px solid color-mix(in srgb,currentColor 20%,transparent); box-shadow:0 4px 18px #0003; font-size:13px; overflow-wrap:anywhere; overflow:auto; }
.pf-dialog.pf-recovery { width:min(540px,100%); }
.pf-root { display:inline-flex; font:inherit; }
.pf-root button { font:inherit; color:inherit; cursor:pointer; border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:6px; background:transparent; padding:6px 10px; }
.pf-root .pf-trigger { border:0; padding:4px 7px; font-size:12px; display:inline-flex; align-items:center; gap:4px; }
.pf-root input { font:inherit; color:inherit; background:transparent; border:1px solid currentColor; border-radius:4px; padding:6px; margin:4px 8px; max-width:100%; box-sizing:border-box; }
.pf-root input:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.pf-threshold-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; padding:10px 12px; border:1px solid color-mix(in srgb,currentColor 10%,transparent); border-radius:8px; background:color-mix(in srgb,currentColor 3%,transparent); }
.pf-threshold-row label { font-size:13px; font-weight:500; white-space:nowrap; }
.pf-root .pf-threshold-row input { width:100px; margin:0; padding:6px 10px; border:1px solid color-mix(in srgb,currentColor 22%,transparent); border-radius:6px; background:var(--dsw-alias-bg-layer-1,Canvas); font-variant-numeric:tabular-nums; }
.pf-root .pf-threshold-row input:focus-visible { border-color:#6688ba; outline:2px solid #6688ba40; outline-offset:1px; }
.pf-threshold-hint { flex:1 1 260px; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary,GrayText); }
.pf-root .pf-primary { background:color-mix(in srgb,currentColor 14%,transparent); border-color:color-mix(in srgb,currentColor 35%,transparent); font-weight:600; }
.pf-root button:hover:not(:disabled),.pf-root summary:hover { background:color-mix(in srgb,currentColor 7%,transparent); }
.pf-root button:disabled { opacity:.45; cursor:not-allowed; }
.pf-root button:focus-visible,.pf-root summary:focus-visible,.pf-detail:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.pf-backdrop { position:fixed; inset:0; z-index:1100; background:#0005; display:flex; align-items:center; justify-content:center; padding:20px; }
.pf-dialog { box-sizing:border-box; width:min(960px,100%); max-height:calc(100dvh - 40px); display:flex; flex-direction:column; background:var(--dsw-alias-bg-layer-1,Canvas); color:var(--dsw-alias-label-primary,CanvasText); border:1px solid color-mix(in srgb,currentColor 18%,transparent); border-radius:10px; box-shadow:0 8px 28px #0003; font:inherit; font-size:13px; line-height:1.5; overflow:hidden; overflow-wrap:anywhere; }
.pf-dialog h3,.pf-dialog h4,.pf-dialog p { margin:0 0 8px; }
.pf-header,.pf-footer { padding:14px 18px; flex-shrink:0; }
.pf-header { border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent); }
.pf-heading,.pf-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.pf-heading h3 { flex:1; font-size:16px; font-weight:500; }
.pf-meta { display:flex; flex-wrap:wrap; gap:2px 16px; margin-top:2px; font-size:12px; opacity:.8; }
.pf-meta p { margin:0; }
.pf-scroll { scrollbar-width:thin; scrollbar-color:color-mix(in srgb,currentColor 30%,transparent) transparent; }
.pf-scroll { overflow:auto; min-height:0; }
.pf-status { padding:10px 18px 0; }
.pf-body { display:grid; grid-template-columns:230px minmax(0,1fr); min-height:260px; }
.pf-nav { padding:10px; display:flex; flex-direction:column; gap:6px; border-right:1px solid color-mix(in srgb,currentColor 14%,transparent); }
.pf-nav button { text-align:left; display:flex; flex-wrap:wrap; align-items:center; gap:2px 6px; padding:7px 9px; }
.pf-nav button strong { flex-basis:100%; }
.pf-nav .pf-counts { font-size:11px; line-height:1.5; }
.pf-nav button[aria-expanded=true] { background:color-mix(in srgb,currentColor 9%,transparent); border-color:color-mix(in srgb,currentColor 40%,transparent); }
.pf-detail { padding:16px; min-width:0; }
.pf-badge { display:inline-block; border:1px solid color-mix(in srgb,currentColor 20%,transparent); border-radius:20px; padding:1px 7px; font-size:11px; }
.pf-counts { font-size:12px; white-space:normal; }
.pf-count { display:inline-block; white-space:nowrap; }
.pf-count-added { color:light-dark(#00852f,#22c55e); }
.pf-count-removed { color:light-dark(#e02030,#ff4d5e); }
.pf-count-changed { color:light-dark(#996e00,#facc15); }
.pf-item { border:1px solid color-mix(in srgb,currentColor 16%,transparent); border-radius:6px; margin:8px 0; }
.pf-item summary { cursor:pointer; padding:10px; }
.pf-item-header { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:10px; }
.pf-values { padding:0 12px 12px; }
.pf-root .pf-eye { display:inline-flex; vertical-align:middle; padding:4px; margin-left:8px; }
.pf-diff { margin:8px 0; border:1px solid color-mix(in srgb,currentColor 20%,transparent); border-radius:5px; overflow:auto; max-width:100%; }
.pf-diff-head { padding:8px; background:color-mix(in srgb,currentColor 6%,transparent); }
.pf-diff-lines { font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; min-width:fit-content; }
.pf-diff-line { display:grid; grid-template-columns:4em 4em 2em minmax(0,1fr); white-space:pre; }
.pf-diff-line > span { padding:0 4px; }
.pf-diff-num { opacity:.6; text-align:right; user-select:none; }
.pf-diff-add { background:light-dark(#dafbe1,#163823); color:light-dark(#116329,#aff5b4); }
.pf-diff-remove { background:light-dark(#ffebe9,#4c2025); color:light-dark(#a40e26,#ffb1af); }
.pf-diff pre { white-space:pre-wrap; overflow-wrap:anywhere; padding:8px; }
.pf-group { margin-top:14px; }
.pf-group h4 { display:flex; align-items:center; }
.pf-footer { border-top:1px solid color-mix(in srgb,currentColor 14%,transparent); }
.pf-footer .pf-actions,.pf-footer.pf-actions { justify-content:flex-end; }
.pf-review { margin-right:auto; }
.pf-note { opacity:.72; font-size:12px; }
.pf-warning { border-left:3px solid #d9a52a; padding-left:9px; }
.pf-info { border-left:3px solid #3b82f6; padding-left:9px; }
.pf-live-status { margin-bottom:10px; }
.pf-live-status h4 { font-size:12px; margin-bottom:2px; opacity:.85; }
@media(max-width:600px) { .pf-backdrop { padding:8px; } .pf-dialog { max-height:calc(100dvh - 16px); } .pf-body { grid-template-columns:1fr; } .pf-nav { display:grid; grid-template-columns:1fr 1fr; border-right:0; border-bottom:1px solid color-mix(in srgb,currentColor 14%,transparent); } }
`
