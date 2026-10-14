# Pocketto — Pocket-driven development skills

Pocketto adalah kumpulan 14 skill core untuk pengembangan perangkat lunak terstruktur:
delegasi subagent, bug hunting, perencanaan iteratif, code review, dan mode mentor edukasi.

> Instalasi ini adalah **Core set**. Skill enterprise (`pocket-enterprise`, `create-pr`)
> tidak termasuk di wave 1 — menyusul di wave 2 (enterprise overlay).

Import skill yang dibutuhkan dari daftar di bawah sesuai tugas yang sedang dikerjakan.
Tiap skill bersifat standalone (on-demand) kecuali yang pipeline (`pocket-grinding` →
`pocket-planning` → `pocket-structuring` → `pocket-development` → `pocket-closing`).

## Skill

@./skills/brand-design/SKILL.md
@./skills/bug-hunting/SKILL.md
@./skills/hotfix/SKILL.md
@./skills/pocket-closing/SKILL.md
@./skills/pocket-development/SKILL.md
@./skills/pocket-education/SKILL.md
@./skills/pocket-grinding/SKILL.md
@./skills/pocket-help/SKILL.md
@./skills/pocket-init/SKILL.md
@./skills/pocket-pitching/SKILL.md
@./skills/pocket-planning/SKILL.md
@./skills/pocket-structuring/SKILL.md
@./skills/structured-research/SKILL.md
@./skills/validate-plan/SKILL.md

## Ringkasan skill

| Skill | Kapan dipakai |
|---|---|
| `pocket-init` | Onboarding proyek baru ke Pocket; menulis panduan proyek, opsional kalibrasi profil belajar |
| `pocket-help` | Panduan onboarding & routing ekosistem skill Pocket ("what is pocket", "which skill") |
| `pocket-pitching` | Eksplorasi masalah yang masih mentah, sebelum grinding (diverge → converge) |
| `pocket-grinding` | Discovery fitur/fix berbasis BDD sebelum implementasi |
| `pocket-planning` | Mengubah spec grinding menjadi rencana eksekusi Pocket Packets (TDD) |
| `pocket-structuring` | Mengubah rencana jadi per-task Pocket Packets + indeks eksekusi |
| `pocket-development` | Eksekusi rencana: paket terbatas, delegasi, review independen, handoff fase |
| `pocket-closing` | Closeout fase/rencana yang sudah lolos review (hanya atas permintaan eksplisit) |
| `bug-hunting` | Perbaiki bug / review proaktif; root cause terkonfirmasi dulu sebelum fix |
| `hotfix` | Perubahan kecil–menengah cepat dengan gate rencana singkat + review subagent |
| `validate-plan` | Validasi rencana implementasi terhadap DRY, YAGNI, TDD sebelum eksekusi |
| `structured-research` | Validasi asumsi eksplisit dengan riset terstruktur (verdict: Confirmed/Refuted/Inconclusive) |
| `brand-design` | Generator design system yang sadar brand; menulis creative-brief.md sebagai source of truth UI/UX |
| `pocket-education` | Mode mentor: manusia menulis kode, agent mengajar & me-review dengan progressive hints |

## Prinsip

- **Baca dulu, jangan menebak.** Setiap klaim harus berasal dari file yang benar-benar diperiksa.
- **Delegasi terstruktur.** Gunakan skill sesuai fasenya; jangan lompat fase.
- `pocket-closing` hanya dijalankan atas permintaan eksplisit user.
