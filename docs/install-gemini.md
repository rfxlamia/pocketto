# Install Pocketto di Gemini CLI

> Status: draf — perintah install mengikuti format resmi `gemini extensions install <git-url>`; smoke test CLI menunggu Gemini CLI tersedia.

Pocketto tersedia sebagai ekstensi Gemini CLI lewat `gemini-extension.json` + `GEMINI.md` di repo ini. `GEMINI.md` meng-import ke-16 skill Pocketto (`@./skills/<nama>/SKILL.md`) supaya langsung discoverable begitu ekstensi aktif.

## Cara install (kanonis)

```bash
gemini extensions install https://github.com/rfxlamia/pocketto
```

Satu baris, langsung dari GitHub — ini jalur resmi Google untuk ekstensi Gemini CLI.

## Syarat

- Gemini CLI terinstall.

## Alternatif (drop-in, terverifikasi spike)

```bash
npx skills add rfxlamia/pocketto -a gemini-cli
```

Terverifikasi di spike 2026-10-14: 16/16 skill terinstall, frontmatter 16/16 ter-parse. Catatan: mode default `npx skills` adalah copy snapshot — untuk update, jalankan `npx skills update`. `npx skills` adalah proyek pihak ketiga (`vercel-labs/skills`), bukan milik repo Pocketto.

## Verifikasi

```bash
gemini extensions list
```

Harusnya ekstensi `pocketto` muncul di daftar.

## Catatan desain

- **Antigravity ikut kebagian.** Fondasi ekstensi yang sama dipakai Antigravity — satu kerjaan, dua harness. Daftar nama agen valid di CLI `skills` juga memuat `antigravity` / `antigravity-cli`, jadi jalur drop-in berlaku di sana juga.
- Perintah di dokumen ini adalah command string yang di-pin di test compatibility (`test/compatibility.test.js`) — jangan diubah tanpa sinkron dengan test.

## Verifikasi [BELUM TERVERIFIKASI]

- [BELUM TERVERIFIKASI] Smoke test end-to-end `gemini extensions install https://github.com/rfxlamia/pocketto` → `gemini extensions list` belum dijalankan (Gemini CLI tidak tersedia di sandbox spike).
- [BELUM TERVERIFIKASI] Konfirmasi bahwa Antigravity membaca `gemini-extension.json` / `GEMINI.md` dengan cara yang sama — didasarkan pada klaim "fondasi sama", belum diuji di Antigravity asli.
