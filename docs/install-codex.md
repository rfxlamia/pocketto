# Install Pocketto di Codex CLI

> Status: draf — jalur marketplace mengikuti pola manifest `.codex-plugin/` (meniru konvensi `.claude-plugin/`); smoke test CLI menunggu Codex CLI tersedia.

Pocketto tersedia sebagai plugin Codex CLI lewat manifest `.codex-plugin/marketplace.json` + `.codex-plugin/plugin.json` di repo ini — pola yang sama dengan marketplace Claude Code.

## Cara install (kanonis)

```bash
codex plugin marketplace add rfxlamia/pocketto
codex plugin add pocketto@pocketto
```

Perintah pertama mendaftarkan marketplace Pocketto; perintah kedua menginstall plugin `pocketto` dari marketplace itu.

## Syarat

- Codex CLI terinstall.

## Alternatif (drop-in, terverifikasi spike)

Kalau jalur marketplace bermasalah, install langsung sebagai skill tanpa lewat plugin system:

```bash
npx skills add rfxlamia/pocketto -a codex
```

Ini drop-in ke `.agents/skills/` (project scope) — Codex membaca folder itu secara native. Terverifikasi di spike 2026-10-14: 16/16 skill terinstall, frontmatter 16/16 ter-parse.

Catatan: mode default `npx skills` adalah copy snapshot — untuk update, jalankan `npx skills update`. `npx skills` adalah proyek pihak ketiga (`vercel-labs/skills`), bukan milik repo Pocketto.

## Verifikasi

- Jalankan `$pocket-init` di Codex — kalau skill-nya kepasang, Codex mengenali dan menjalankan workflow init Pocketto.
- Atau cek daftar skills yang dikenali Codex di sesi kamu.
- Fallback (jalur drop-in): pastikan folder `.agents/skills/` ada di project dir dan berisi 16 folder skill.

## Catatan desain

- **Frontmatter kompatibel Codex.** Frontmatter resmi Codex cuma `name` + `description` — 15 dari 16 SKILL.md Pocketto sudah bersih; satu-satunya pengecualian `skills/validate-plan/SKILL.md` yang punya key tambahan `category: planning` (ditemukan spike 2026-10-14; penghapusan key-nya menunggu izin V karena menyentuh repo).
- Perintah di dokumen ini adalah command string yang di-pin di test compatibility (`test/compatibility.test.js`) — jangan diubah tanpa sinkron dengan test.

## Verifikasi [BELUM TERVERIFIKASI]

- [BELUM TERVERIFIKASI] Smoke test end-to-end `codex plugin marketplace add` → `codex plugin add` di Codex CLI asli belum dijalankan (Codex CLI tidak tersedia di sandbox spike).
- [BELUM TERVERIFIKASI] Perilaku key frontmatter `category` (di `validate-plan`) di Codex CLI asli — kemungkinan besar diabaikan, tapi belum diuji.
