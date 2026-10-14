# Install Pocketto di Harness Drop-in (Cursor, Cline, Zed, Crush, Kilo Code, Junie, Qwen Code)

Keluarga ini dilayani satu role (`agents/core`) dan satu installer kanonis: **`npx skills add`** (vercel-labs/skills). Harness-harness ini membaca folder `.agents/skills/` secara native, jadi tidak butuh manifest khusus — cukup copy skill ke sana.

> Nama `-a` di bawah adalah nama persis dari registry CLI `skills` (terverifikasi spike 2026-10-14). Jangan menebak — misalnya `-a copilot` **invalid**, yang benar `-a github-copilot`.

## Perintah per harness

```bash
# Cursor
npx skills add rfxlamia/pocketto -a cursor

# Cline
npx skills add rfxlamia/pocketto -a cline

# Zed
npx skills add rfxlamia/pocketto -a zed

# Crush
npx skills add rfxlamia/pocketto -a crush

# Kilo Code
npx skills add rfxlamia/pocketto -a kilo

# JetBrains Junie / AI Assistant
npx skills add rfxlamia/pocketto -a junie

# Qwen Code
npx skills add rfxlamia/pocketto -a qwen-code
```

Spike 2026-10-14 mengonfirmasi untuk `cursor` dan `cline`: 16/16 skill terinstall, frontmatter ter-parse 16/16, tanpa login, non-interaktif. Harness lain (`zed`, `crush`, `kilo`, `junie`, `qwen-code`) ada di registry nama agen yang sama dan memakai pola `.agents/skills/` yang identik — [BELUM TERVERIFIKASI] satu per satu di sandbox, tapi pola teknisnya sama.

Jalankan dari direktori project kamu — install bersifat **project scope** (masuk ke `<project>/.agents/skills/`), bukan global.

## Alternatif: copy manual

Kalau `npx skills` tidak bisa dipakai (misalnya offline atau tanpa node), copy manual folder `skills/` dari repo ke project kamu:

```bash
git clone --depth 1 https://github.com/rfxlamia/pocketto /tmp/pocketto
mkdir -p .agents/skills
cp -r /tmp/pocketto/skills/* .agents/skills/
```

Struktur yang diharapkan per skill: `.agents/skills/<nama-skill>/SKILL.md`.

## Catatan umum `npx skills`

- Mode default dari repo GitHub = **copy snapshot** (bukan symlink). Install tidak auto-update — untuk update jalankan:

  ```bash
  npx skills update
  ```

- `npx skills` adalah proyek pihak ketiga (`vercel-labs/skills`), bukan milik repo Pocketto. Untuk hal yang butuh jaminan (enterprise overlay, `doctor`), jalur ini tidak dipakai — kanonis hanya untuk keluarga drop-in yang memang tidak punya alternatif resmi.
- Di skrip non-interaktif, tutup stdin (`</dev/null`) supaya prompt tak terlihat tidak menggantung.

## Verifikasi per harness

Verifikasi umum (berlaku untuk semua, terverifikasi spike):

```bash
npx skills list
```

Harusnya menampilkan 16 skill dengan source `rfxlamia/pocketto` untuk project dir tersebut.

Panel bawaan masing-masing harness ([BELUM TERVERIFIKASI] satu per satu — langkah ini mengikuti pola umum tiap harness):

| Harness | Cara cek |
|---|---|
| Cursor | Settings → Rules & Skills — 16 skill Pocket muncul di daftar |
| Cline | Panel Skills di Cline — skill Pocketto terdaftar |
| Zed | Panel/agent skills di Zed — skill dari `.agents/skills/` terbaca |
| Crush | Daftar skills Crush — 16 skill Pocket terdeteksi |
| Kilo Code | Panel Skills Kilo Code — skill Pocketto terdaftar |
| JetBrains Junie / AI Assistant | Skills settings di IDE JetBrains — skill Pocketto terdaftar |
| Qwen Code | Daftar skills Qwen Code — 16 skill Pocket terdeteksi |

## Catatan desain

- Satu role `agents/core` melayani ketujuh harness — harness baru yang `.agents/skills/`-native di masa depan cukup docs-only, tanpa perubahan `surfaces.json`.
- Perintah `npx skills add rfxlamia/pocketto -a <nama>` di dokumen ini adalah command string yang di-pin di test compatibility — jangan diubah tanpa sinkron dengan test.
