# Install Pocketto di GitHub Copilot CLI

> Status: draf — belum smoke test end-to-end. Lihat [catatan verifikasi](#verifikasi) di bawah.

Pocketto tersedia sebagai plugin Copilot CLI. Single source of truth-nya adalah manifest `.claude-plugin/` yang sudah ada — Copilot CLI membaca ulang manifest itu apa adanya, jadi tidak ada manifest fork khusus Copilot di repo ini.

## Cara install (kanonis)

```bash
copilot plugin marketplace add rfxlamia/pocketto
copilot plugin install pocketto@pocketto
```

Perintah pertama mendaftarkan marketplace Pocketto; perintah kedua menginstall plugin `pocketto` dari marketplace itu.

## Syarat

- Copilot CLI terinstall dan bisa jalan di terminal.
- Login GitHub yang punya akses Copilot (perintah plugin Copilot CLI butuh autentikasi GitHub).

## Alternatif (pihak ketiga)

Kalau jalur plugin bermasalah, atau kamu mau install tanpa lewat marketplace:

```bash
npx skills add rfxlamia/pocketto -a github-copilot
```

> ⚠️ Nama agennya **harus `github-copilot`** — `-a copilot` ditolak CLI-nya ("Invalid agents: copilot"). Terverifikasi di spike 2026-10-14: 16/16 skill terinstall.

Atau via GitHub CLI:

```bash
gh skill install
```

Catatan alternatif `npx skills`: ini copy snapshot (bukan symlink) — untuk update, jalankan `npx skills update` di direktori project. `npx skills` adalah proyek pihak ketiga (`vercel-labs/skills`), bukan milik repo Pocketto.

## Verifikasi

```bash
copilot skill list
```

Harusnya terlihat 16 skill Pocket (pocket-init, pocket-pitching, pocket-planning, pocket-structuring, pocket-development, pocket-grinding, pocket-closing, pocket-help, bug-hunting, hotfix, structured-research, validate-plan, brand-design, pocket-education, pocket-enterprise, create-pr).

Kalau tidak ada di list, restart sesi Copilot CLI dulu, baru jalankan `copilot skill list` lagi.

## Catatan desain

- **Reuse manifest, tanpa fork.** Installer Copilot memakai ulang `.claude-plugin/marketplace.json` yang sama dipakai Claude Code. Tidak ada `.copilot-plugin/` atau `.github/plugin/` di repo — itu keputusan sadar, supaya satu file manifest tidak perlu di-sync dua kali selamanya.
- Perintah di dokumen ini adalah command string yang di-pin di test compatibility (`test/compatibility.test.js`) — jangan diubah tanpa sinkron dengan test.

## Verifikasi [BELUM TERVERIFIKASI]

- [BELUM TERVERIFIKASI] Smoke test end-to-end `copilot plugin marketplace add rfxlamia/pocketto` → `copilot plugin install pocketto@pocketto` → `copilot skill list` **belum pernah dijalankan di manifest Pocketto**. Butuh Copilot CLI + login GitHub milik V (aksi V, bukan sesuatu yang bisa dikerjakan agent). Dasarnya: bukti komunitas 2+ repo + dok GitHub, tapi untuk repo ini masih asumsi.
- [BELUM TERVERIFIKASI] Kalau reuse manifest gagal, fallback-nya `.github/plugin/plugin.json` khusus (tambahan ~0,5 sprint).
