Hierarchy expected under this folder:

comparisions/
  <PLANT>/
    <YYYY-MM-DD>/
      System/
      vedanjay/
      compared/

Script:
  compare_schedules.py

Run with hierarchy mode:
  python compare_schedules.py --root "<path_to_comparisions>" --plant GSNP --date 2026-03-12

Run with direct paths:
  python compare_schedules.py --system "<system_file_or_dir>" --vedanjay "<vedanjay_file_or_dir>" --out "<out_dir>" --date 2026-03-12

Outputs:
  compared/schedule-comparison-<date>.csv
  compared/schedule-comparison-<date>.html
