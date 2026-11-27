// Turns lesson text into phone pages. Used by the owner app and by the admin preview, so both look the same.
//
// Lesson text format (simple on purpose, so anyone can write it):
//   ---                  on its own line: new page (owners swipe Next)
//   # Heading            big heading        ## Smaller heading
//   - item               bullet list (one item per line)
//   > text               "remember this" box
//   **bold**             bold words
//   [[picture:ID]]       a picture (added with "Add picture" in the admin app)
//   A blank line starts a new paragraph.
"use strict";
(function (root) {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const inline = t => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // One block (text between blank lines). Lines of the same kind are grouped: bullets into a list,
  // "> " lines into a box, plain lines into a paragraph. Headings and pictures stand alone.
  function block(b, picUrl) {
    const out = [];
    let group = null;
    const flush = () => {
      if (!group) return;
      if (group.kind === "ul") out.push(`<ul>${group.lines.map(l => `<li>${inline(l)}</li>`).join("")}</ul>`);
      else if (group.kind === "box") out.push(`<div class="remember">${group.lines.map(inline).join("<br>")}</div>`);
      else out.push(`<p>${group.lines.map(inline).join("<br>")}</p>`);
      group = null;
    };
    const add = (kind, line) => { if (group?.kind !== kind) { flush(); group = { kind, lines: [] }; } group.lines.push(line); };
    for (const raw of b.split("\n")) {
      const l = raw.trim();
      if (!l) continue;
      const pic = l.match(/^\[\[picture:([\w-]{8,64})\]\]$/);
      if (pic) { flush(); out.push(`<figure class="pic"><img src="${esc(picUrl(pic[1]))}" alt="" loading="lazy" decoding="async"></figure>`); }
      else if (/^## /.test(l)) { flush(); out.push(`<h3>${inline(l.slice(3))}</h3>`); }
      else if (/^# /.test(l)) { flush(); out.push(`<h2>${inline(l.slice(2))}</h2>`); }
      else if (/^[-•*] /.test(l)) add("ul", l.slice(2));
      else if (/^>/.test(l)) add("box", l.replace(/^> ?/, ""));
      else add("p", l);
    }
    flush();
    return out.join("");
  }

  function lessonPages(body, picUrl) {
    picUrl = picUrl || (id => "/api/learn/pictures/" + id);
    const text = String(body || "").replace(/\r\n?/g, "\n");
    return text.split(/\n\s*-{3,}\s*\n/).map(page => page.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(b => block(b, picUrl)).join(""))
      .filter(Boolean);
  }

  root.lessonPages = lessonPages;
})(typeof window !== "undefined" ? window : globalThis);
