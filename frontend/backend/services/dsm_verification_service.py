from __future__ import annotations

import csv
import io
import logging
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

from openpyxl import load_workbook
from openpyxl.formula.translate import Translator
from openpyxl.utils import get_column_letter
from sqlalchemy.orm import Session

from models import DsmPssConfig, DsmVerificationRun, DsmVerificationRunFile, DsmVerificationTemplate
from services.excel_recalculation_service import recalculate_excel_workbook
from services.all_plant_penalty_service import parse_schedule_upload, sha256_bytes


CONFIG_FILE = Path(__file__).resolve().parent.parent / "config" / "template_pipeline" / "dsm_verification.json"
ROWS_PER_DAY = 96
DEFAULT_DAYS = 7
REQUIRED_TEMPLATE_SHEETS = {
    "Final_Summary",
    "Summary_WA",
    "Summary_WoA",
    "Aggregated_Calculations",
}
MIN_TEMPLATE_FORMULAS = 100
REQUIRED_TEMPLATE_FORMULA_CELLS = {
    "Aggregated_Calculations": ("G4", "AK4", "BR4", "CG4"),
    "Summary_WA": ("D8", "D10", "D20"),
    "Summary_WoA": ("D8", "D13", "D15"),
    "Final_Summary": ("D7", "E7", "F7"),
}

LOGGER = logging.getLogger(__name__)
DEFAULT_DSM_SCHEDULE_GENERATORS = ("SPRNG", "SEIT")

OFFICIAL_REPORT_COLUMN_ALIASES = {
    "date": ("date",),
    "block": ("block", "timeblock", "time_block"),
    "actual_mwh": ("actualmwh", "actual", "actualmwhmw", "actualmwhs"),
    "schedule_mwh": ("schedulemwh", "schedule", "scheduledmwh"),
    "avc_mwh": ("wssellercapacitymwh", "wssellercapacity", "capacitymwh"),
    "ppa_pmwh": ("regenpparatepmwh", "regenpparate", "weightedaveragepparatepmwh"),
}
OFFICIAL_REPORT_MWH_TO_MW_MULTIPLIER = 4.0
OFFICIAL_REPORT_PPA_DIVISOR = 1000.0
REWA_AGGREGATED_ROW4_FORMULAS = {
    "A": '=DATE(YEAR(Final_Summary!$E$4),MONTH(Final_Summary!$E$4),DAY(Final_Summary!$E$4))+INT((ROW()-4)/96)',
    "B": '=TEXT(MOD((ROW()-4)*15,1440)/1440,"hh:mm") & "-" & TEXT(MOD((ROW()-4)*15+15,1440)/1440,"hh:mm")',
    "G": "=IFERROR(ABS(D4-C4)*250,0)",
    "H": "=IF(C4<D4,IF((-C4+D4)<(0.15*E4),(D4-C4),(0.15*E4)),0)",
    "I": "=IF(C4<D4,IF((-C4+D4)>(0.25*E4),(0.1*E4),(D4-C4-H4)),0)",
    "J": "=IF(C4<D4,IF((-C4+D4)>(0.35*E4),(0.1*E4),(D4-C4-H4-I4)),0)",
    "K": "=IF(C4<D4,IF((-C4+D4)>(0.35*E4),(D4-C4-H4-I4-J4),0),0)",
    "L": "=IF(C4>D4,IF((C4-D4)<0.15*E4,(D4-C4),-0.15*E4),0)",
    "M": "=IF(C4>D4,IF((C4-D4)<0.25*E4,(D4-C4-L4),-0.1*E4),0)",
    "N": "=IF(C4>D4,IF((C4-D4)<0.35*E4,(D4-C4-L4-M4),-0.1*E4),0)",
    "O": "=IF(C4>D4,IF((C4-D4)>0.35*E4,(D4-C4-L4-M4-N4),0),0)",
    "P": "=SUM(H4:O4)",
    "Q": '=IF((P4-D4)<0.01,"OK","ERROR")',
    "V": "=IFERROR(ABS(S4-R4)*250,0)",
    "W": "=IF(R4<S4,IF((-R4+S4)<(0.15*T4),(S4-R4),(0.15*T4)),0)",
    "X": "=IF(R4<S4,IF((-R4+S4)>(0.25*T4),(0.1*T4),(S4-R4-W4)),0)",
    "Y": "=IF(R4<S4,IF((-R4+S4)>(0.35*T4),(0.1*E4),(S4-R4-W4-X4)),0)",
    "Z": "=IF(R4<S4,IF((-R4+S4)>(0.35*T4),(S4-R4-W4-X4-Y4),0),0)",
    "AA": "=IF(R4>S4,IF((R4-S4)<0.15*T4,(S4-R4),-0.15*T4),0)",
    "AB": "=IF(R4>S4,IF((R4-S4)<0.25*T4,(S4-R4-AA4),-0.1*T4),0)",
    "AC": "=IF(R4>S4,IF((R4-S4)<0.35*T4,(S4-R4-AA4-AB4),-0.1*T4),0)",
    "AD": "=IF(R4>S4,IF((R4-S4)>0.35*T4,(S4-R4-AA4-AB4-AC4),0),0)",
    "AE": "=SUM(W4:AD4)",
    "AF": '=IF((AE4-S4)<0.01,"OK","ERROR")',
    "AG": "=SUM(C4,R4)",
    "AH": "=SUM(D4,S4)",
    "AI": "=SUM(E4,T4)",
    "AJ": "=AVERAGE(F4,U4)",
    "AK": "=IFERROR(ABS(AH4-AG4)*250,0)",
    "AL": "=IF(AG4<AH4,IF((-AG4+AH4)<(0.15*AI4),(AH4-AG4),(0.15*AI4)),0)",
    "AM": "=IF(AG4<AH4,IF((-AG4+AH4)>(0.25*AI4),(0.1*AI4),(AH4-AG4-AL4)),0)",
    "AN": "=IF(AG4<AH4,IF((-AG4+AH4)>(0.35*AI4),(0.1*T4),(AH4-AG4-AL4-AM4)),0)",
    "AO": "=IF(AG4<AH4,IF((-AG4+AH4)>(0.35*AI4),(AH4-AG4-AL4-AM4-AN4),0),0)",
    "AP": "=IF(AG4>AH4,IF((AG4-AH4)<0.15*AI4,(AH4-AG4),-0.15*AI4),0)",
    "AQ": "=IF(AG4>AH4,IF((AG4-AH4)<0.25*AI4,(AH4-AG4-AP4),-0.1*AI4),0)",
    "AR": "=IF(AG4>AH4,IF((AG4-AH4)<0.35*AI4,(AH4-AG4-AP4-AQ4),-0.1*AI4),0)",
    "AS": "=IF(AG4>AH4,IF((AG4-AH4)>0.35*AI4,(AH4-AG4-AP4-AQ4-AR4),0),0)",
    "AT": "=SUM(AL4:AS4)",
    "AU": '=IF((AT4-AH4)<0.01,"OK","ERROR")',
    "AV": "=IF(D4>0,(D4*F4*250),0)",
    "AW": "=IF(S4>0,(S4*U4*250),0)",
    "AX": "=SUM(AV4:AW4)",
    "AY": "=C4*250*F4",
    "AZ": "=R4*250*U4",
    "BA": "=AG4*250*AJ4",
    "BB": "=ROUND((H4+I4*0.9+J4*0.8+K4*0.7)*250*F4,2)",
    "BC": "=ROUND((L4+M4*1.1+N4*1.2+O4*1.3)*F4*250,2)",
    "BD": "=ROUND((W4+X4*0.9+Y4*0.8+Z4*0.7)*250*U4,2)",
    "BE": "=ROUND((AA4+AB4*1.1+AC4*1.2+AD4*1.3)*250*U4,2)",
    "BF": "=SUM(BB4,BD4)",
    "BG": "=SUM(BC4,BE4)",
    "BH": "=ROUND((AL4+AM4*0.9+AN4*0.8+AO4*0.7)*250*AJ4,2)",
    "BI": "=ROUND((AP4*1+AQ4*1.1+AR4*1.2+AS4*1.3)*250*AJ4,2)",
    "BJ": "=(I4*0.1+J4*0.2+K4*0.3)*250*F4",
    "BK": "=(M4*0.1+N4*0.2+O4*0.3)*250*F4",
    "BL": "=(X4*0.1+Y4*0.2+Z4*0.3)*250*U4",
    "BM": "=(AB4*0.1+AC4*0.2+AD4*0.3)*250*U4",
    "BN": "=SUM(BJ4,BL4)",
    "BO": "=SUM(BK4,BM4)",
    "BP": "=(AM4*0.1+AN4*0.2+AO4*0.3)*250*AJ4",
    "BQ": "=(AP4*0+AQ4*0.1+AR4*0.2+AS4*0.3)*AJ4*250",
    "BR": "=IF($BP4=0,0,(BJ4/$BN4)*$BP4)",
    "BS": "=IF($BQ4=0,0,($BK4/$BO4)*$BQ4)",
    "BT": "=IF($BP4=0,0,(BL4/$BN4)*$BP4)",
    "BU": "=IF($BQ4=0,0,($BM4/$BO4)*$BQ4)",
    "BV": "=ABS(IF(AND(C4=0,D4<0),D4*250*F4,0))",
    "BW": "=ABS(IF(AND(R4=0,S4<0),S4*250*U4,0))",
    "BX": "=IF(BV4>0,0,(D4-C4)*250*F4)",
    "BY": "=IF(BW4>0,0,(S4-R4)*U4*250)",
    "BZ": "=D4*250*F4",
    "CA": "=S4*250*U4",
    "CB": "=SUM(BZ4:CA4)",
    "CC": "=AH4*250*AJ4",
    "CD": "=(C4-D4)*250*F4+(R4-S4)*250*U4",
    "CE": "=(AG4-AH4)*250*AJ4",
    "CF": "=CD4-CE4",
    "CG": "=IF(BZ4=0,0,(BZ4/$CB4)*$CF4)",
    "CH": "=IF(CA4=0,0,(CA4/$CB4)*$CF4)",
}

REWA_EXTENDED_INPUT_COLUMNS = {
    "C",
    "D",
    "E",
    "F",
    "R",
    "S",
    "T",
    "U",
    "AG",
    "AH",
    "AI",
    "AJ",
    "AV",
    "AW",
    "AX",
    "AY",
}
REWA_2026_INPUT_COLUMNS = {
    "C",
    "D",
    "E",
    "F",
    "P",
    "Q",
    "R",
    "S",
    "AC",
    "AD",
    "AE",
    "AF",
    "AP",
    "AQ",
    "AR",
    "AS",
}
REWA_EXTENDED_AGGREGATED_ROW4_FORMULAS = {
    column: formula
    for column, formula in REWA_AGGREGATED_ROW4_FORMULAS.items()
    if column not in REWA_EXTENDED_INPUT_COLUMNS
}
REWA_EXTENDED_AGGREGATED_ROW4_FORMULAS.update(
    {
        "AZ": "=IFERROR(ABS(AW4-AV4)*250,0)",
        "BA": "=IF(AV4<AW4,IF((-AV4+AW4)<(0.15*AX4),(AW4-AV4),(0.15*AX4)),0)",
        "BB": "=IF(AV4<AW4,IF((-AV4+AW4)>(0.25*AX4),(0.1*AX4),(AW4-AV4-BA4)),0)",
        "BC": "=IF(AV4<AW4,IF((-AV4+AW4)>(0.35*AX4),(0.1*AX4),(AW4-AV4-BA4-BB4)),0)",
        "BD": "=IF(AV4<AW4,IF((-AV4+AW4)>(0.35*AX4),(AW4-AV4-BA4-BB4-BC4),0),0)",
        "BE": "=IF(AV4>AW4,IF((AV4-AW4)<0.15*AX4,(AW4-AV4),-0.15*AX4),0)",
        "BF": "=IF(AV4>AW4,IF((AV4-AW4)<0.25*AX4,(AW4-AV4-BE4),-0.1*AX4),0)",
        "BG": "=IF(AV4>AW4,IF((AV4-AW4)<0.35*AX4,(AW4-AV4-BE4-BF4),-0.1*AX4),0)",
        "BH": "=IF(AV4>AW4,IF((AV4-AW4)>0.35*AX4,(AW4-AV4-BE4-BF4-BG4),0),0)",
        "BI": "=SUM(BA4:BH4)",
        "BJ": '=IF((BI4-AW4)<0.01,"OK","ERROR")',
        "BK": "=IF(D4>0,(D4*F4*250),0)",
        "BL": "=IF(S4>0,(S4*U4*250),0)",
        "BM": "=IF(AH4>0,(AH4*AJ4*250),0)",
        "BN": "=SUM(BK4:BM4)",
        "BO": "=C4*250*F4",
        "BP": "=R4*250*U4",
        "BQ": "=AG4*250*AJ4",
        "BR": "=AV4*250*AY4",
        "BS": "=ROUND((H4+I4*0.9+J4*0.8+K4*0.7)*250*F4,2)",
        "BT": "=ROUND((L4+M4*1.1+N4*1.2+O4*1.3)*F4*250,2)",
        "BU": "=ROUND((W4+X4*0.9+Y4*0.8+Z4*0.7)*250*U4,2)",
        "BV": "=ROUND((AA4+AB4*1.1+AC4*1.2+AD4*1.3)*250*U4,2)",
        "BW": "=ROUND((AL4+AM4*0.9+AN4*0.8+AO4*0.7)*250*AJ4,2)",
        "BX": "=ROUND((AP4+AQ4*1.1+AR4*1.2+AS4*1.3)*250*AJ4,2)",
        "BY": "=SUM(BS4,BU4,BW4)",
        "BZ": "=SUM(BT4,BV4,BX4)",
        "CA": "=ROUND((BA4+BB4*0.9+BC4*0.8+BD4*0.7)*250*AY4,2)",
        "CB": "=ROUND((BE4*1+BF4*1.1+BG4*1.2+BH4*1.3)*250*AY4,2)",
        "CC": "=(I4*0.1+J4*0.2+K4*0.3)*250*F4",
        "CD": "=(M4*0.1+N4*0.2+O4*0.3)*250*F4",
        "CE": "=(X4*0.1+Y4*0.2+Z4*0.3)*250*U4",
        "CF": "=(AB4*0.1+AC4*0.2+AD4*0.3)*250*U4",
        "CG": "=(AM4*0.1+AN4*0.2+AO4*0.3)*250*AJ4",
        "CH": "=(AQ4*0.1+AR4*0.2+AS4*0.3)*250*AJ4",
        "CI": "=SUM(CC4,CE4,CG4)",
        "CJ": "=SUM(CD4,CF4,CH4)",
        "CK": "=(BB4*0.1+BC4*0.2+BD4*0.3)*250*AY4",
        "CL": "=(BE4*0+BF4*0.1+BG4*0.2+BH4*0.3)*AY4*250",
        "CM": "=IF($CK4=0,0,(CC4/$CI4)*$CK4)",
        "CN": "=IF($CL4=0,0,($CD4/$CJ4)*$CL4)",
        "CO": "=IF($CK4=0,0,(CE4/$CI4)*$CK4)",
        "CP": "=IF($CL4=0,0,($CF4/$CJ4)*$CL4)",
        "CQ": "=IF($CK4=0,0,(CG4/$CI4)*$CK4)",
        "CR": "=IF($CL4=0,0,($CH4/$CJ4)*$CL4)",
        "CS": "=ABS(IF(AND(C4=0,D4<0),D4*250*F4,0))",
        "CT": "=ABS(IF(AND(R4=0,S4<0),S4*250*U4,0))",
        "CU": "=ABS(IF(AND(AG4=0,AH4<0),AH4*250*AJ4,0))",
        "CV": "=IF(CS4>0,0,(D4-C4)*250*F4)",
        "CW": "=IF(CT4>0,0,(S4-R4)*U4*250)",
        "CX": "=IF(CU4>0,0,(AH4-AG4)*AJ4*250)",
        "CY": "=D4*250*F4",
        "CZ": "=S4*250*U4",
        "DA": "=AH4*250*AJ4",
        "DB": "=SUM(CY4:CZ4:DA4)",
        "DC": "=AW4*250*AY4",
        "DD": "=(C4-D4)*250*F4+(R4-S4)*250*U4+(AG4-AH4)*250*AJ4",
        "DE": "=(AV4-AW4)*250*AY4",
        "DF": "=DD4-DE4",
        "DG": "=IF(CY4=0,0,(CY4/$DB4)*$DF4)",
        "DH": "=IF(CZ4=0,0,(CZ4/$DB4)*$DF4)",
        "DI": "=IF(DA4=0,0,(DA4/$DB4)*$DF4)",
    }
)

REWA_SUMMARY_FORMULAS = {
    "Final_Summary": {
        "F6": "=D6+E6",
        "D7": "=(Summary_WA!D12+Summary_WA!D13)-(Summary_WA!D10+Summary_WA!D11)",
        "E7": "=(Summary_WA!E12+Summary_WA!E13)-(Summary_WA!E10+Summary_WA!E11)",
        "F7": "=(Summary_WA!F12+Summary_WA!F13)-(Summary_WA!F10+Summary_WA!F11)",
        "D8": '=IF(D7>0,"Receivable","Payable")',
        "E8": '=IF(E7>0,"Receivable","Payable")',
        "F8": '=IF(F7>0,"Receivable","Payable")',
    },
    "Summary_WA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "F6": "=SUM(D6:E6)",
        "D8": '=SUMIFS(Aggregated_Calculations!BR:BR,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E8": '=SUMIFS(Aggregated_Calculations!BT:BT,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F8": "=SUM(D8:E8)",
        "D9": '=SUMIFS(Aggregated_Calculations!BS:BS,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!BU:BU,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F9": "=SUM(D9:E9)",
        "D10": "=D8-D9",
        "E10": "=SUM(E8-E9)",
        "F10": "=SUM(D10:E10)",
        "D11": '=SUMIFS(Aggregated_Calculations!BV:BV,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E11": '=SUMIFS(Aggregated_Calculations!BW:BW,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F11": "=SUM(D11:E11)",
        "D12": '=SUMIFS(Aggregated_Calculations!BX:BX,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E12": '=SUMIFS(Aggregated_Calculations!BY:BY,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F12": '=SUMIFS(Aggregated_Calculations!BX:BX,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)+SUMIFS(Aggregated_Calculations!BY:BY,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D13": '=SUMIFS(Aggregated_Calculations!CG:CG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E13": '=SUMIFS(Aggregated_Calculations!CH:CH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F13": '=SUMIFS(Aggregated_Calculations!CG:CG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)+SUMIFS(Aggregated_Calculations!CH:CH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D14": '=SUMIFS(Aggregated_Calculations!C:C,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E14": '=SUMIFS(Aggregated_Calculations!R:R,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F14": '=SUMIFS(Aggregated_Calculations!AG:AG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "D15": '=SUMIFS(Aggregated_Calculations!D:D,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E15": '=SUMIFS(Aggregated_Calculations!S:S,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F15": '=SUMIFS(Aggregated_Calculations!AH:AH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "D16": "=D15/F15",
        "E16": "=E15/F15",
        "F16": "=SUM(D16:E16)",
        "D17": '=SUMIFS(Aggregated_Calculations!AY:AY,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E17": '=SUMIFS(Aggregated_Calculations!AZ:AZ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F17": '=SUMIFS(Aggregated_Calculations!BA:BA,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D18": "=D15*Summary_WoA!D7",
        "E18": "=E15*Summary_WoA!E7",
        "F18": "=F15*F7",
        "D19": "=D18+Final_Summary!D7",
        "E19": "=E18+Final_Summary!E7",
        "F19": "=F18+Final_Summary!F7",
        "D20": "=D10/D18",
        "E20": "=E10/E18",
        "F20": "=F10/F18",
    },
    "Summary_WoA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "D7": "=Aggregated_Calculations!F4",
        "E7": "=Aggregated_Calculations!U4",
        "D8": '=ABS(SUMIFS(Aggregated_Calculations!BB:BB,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E8": '=ABS(SUMIFS(Aggregated_Calculations!BD:BD,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D9": '=SUMIFS(Aggregated_Calculations!BC:BC,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!BE:BE,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "D10": "=SUM(D8,D9)",
        "E10": "=SUM(E8,E9)",
        "D11": '=ABS(SUMIFS(Aggregated_Calculations!BJ:BJ,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E11": '=ABS(SUMIFS(Aggregated_Calculations!BL:BL,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D12": '=ABS(SUMIFS(Aggregated_Calculations!BK:BK,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E12": '=ABS(SUMIFS(Aggregated_Calculations!BM:BM,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D13": "=SUM(D11:D12)",
        "E13": "=SUM(E11:E12)",
        "D14": "=Summary_WA!D17-(-Summary_WoA!D10)",
        "E14": "=Summary_WA!E17-(-Summary_WoA!E10)",
        "D15": "=D13/Summary_WA!D18",
        "E15": "=E13/Summary_WA!E18",
    },
}

REWA_EXTENDED_SUMMARY_FORMULAS = {
    "Final_Summary": {
        "G6": "=SUM(D6:F6)",
        "D7": "=(Summary_WA!D12+Summary_WA!D13)-(Summary_WA!D10+Summary_WA!D11)",
        "E7": "=(Summary_WA!E12+Summary_WA!E13)-(Summary_WA!E10+Summary_WA!E11)",
        "F7": "=(Summary_WA!F12+Summary_WA!F13)-(Summary_WA!F10+Summary_WA!F11)",
        "G7": "=SUM(D7:F7)",
        "D8": '=IF(D7>0,"Receivable","Payable")',
        "E8": '=IF(E7>0,"Receivable","Payable")',
        "F8": '=IF(F7>0,"Receivable","Payable")',
        "G8": '=IF(G7>0,"Receivable","Payable")',
    },
    "Summary_WA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "D7": "=Aggregated_Calculations!F4",
        "E7": "=Aggregated_Calculations!U4",
        "F7": "=Aggregated_Calculations!AJ4",
        "G6": "=SUM(D6:F6)",
        "G7": "=Aggregated_Calculations!AY4",
        "D8": '=SUMIFS(Aggregated_Calculations!CM:CM,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E8": '=SUMIFS(Aggregated_Calculations!CO:CO,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F8": '=SUMIFS(Aggregated_Calculations!CQ:CQ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G8": "=SUM(D8:F8)",
        "D9": '=SUMIFS(Aggregated_Calculations!CN:CN,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!CP:CP,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F9": '=SUMIFS(Aggregated_Calculations!CR:CR,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G9": "=SUM(D9:F9)",
        "D10": "=D8-D9",
        "E10": "=(E8-E9)",
        "F10": "=SUM(F8-F9)",
        "G10": "=SUM(D10:F10)",
        "D11": '=SUMIFS(Aggregated_Calculations!CS:CS,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E11": '=SUMIFS(Aggregated_Calculations!CT:CT,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F11": '=SUMIFS(Aggregated_Calculations!CU:CU,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G11": "=SUM(D11:F11)",
        "D12": '=SUMIFS(Aggregated_Calculations!CV:CV,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E12": '=SUMIFS(Aggregated_Calculations!CW:CW,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F12": '=SUMIFS(Aggregated_Calculations!CX:CX,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G12": "=SUM(D12:F12)",
        "D13": '=SUMIFS(Aggregated_Calculations!DG:DG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E13": '=SUMIFS(Aggregated_Calculations!DH:DH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F13": '=SUMIFS(Aggregated_Calculations!DI:DI,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G13": "=SUM(D13:F13)",
        "D14": '=SUMIFS(Aggregated_Calculations!C:C,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E14": '=SUMIFS(Aggregated_Calculations!R:R,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F14": '=SUMIFS(Aggregated_Calculations!AG:AG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "G14": "=SUM(D14:F14)",
        "D15": '=SUMIFS(Aggregated_Calculations!D:D,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E15": '=SUMIFS(Aggregated_Calculations!S:S,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F15": '=SUMIFS(Aggregated_Calculations!AH:AH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "G15": "=SUM(D15:F15)",
        "D16": "=D15/G15",
        "E16": "=E15/G15",
        "F16": "=F15/G15",
        "G16": "=G15/G14",
        "D17": '=SUMIFS(Aggregated_Calculations!BO:BO,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E17": '=SUMIFS(Aggregated_Calculations!BP:BP,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F17": '=SUMIFS(Aggregated_Calculations!BQ:BQ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G17": "=SUM(D17:F17)",
        "D18": '=SUMIFS(Aggregated_Calculations!BK:BK,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E18": '=SUMIFS(Aggregated_Calculations!BL:BL,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F18": '=SUMIFS(Aggregated_Calculations!BM:BM,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G18": "=SUM(D18:F18)",
        "D19": "=D18+Final_Summary!D7",
        "E19": "=E18+Final_Summary!E7",
        "F19": "=F18+Final_Summary!F7",
        "G19": "=G18+Final_Summary!G7",
        "D20": "=D10/D18",
        "E20": "=E10/E18",
        "F20": "=F10/F18",
        "G20": "=G10/G18",
    },
    "Summary_WoA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "D7": "=Aggregated_Calculations!F4",
        "E7": "=Aggregated_Calculations!U4",
        "F7": "=Aggregated_Calculations!AJ4",
        "G6": "=SUM(D6:F6)",
        "G7": "=Aggregated_Calculations!AY4",
        "D8": '=ABS(SUMIFS(Aggregated_Calculations!BS:BS,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E8": '=ABS(SUMIFS(Aggregated_Calculations!BU:BU,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F8": '=ABS(SUMIFS(Aggregated_Calculations!BW:BW,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "G8": "=SUM(D8:F8)",
        "D9": '=SUMIFS(Aggregated_Calculations!BT:BT,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!BV:BV,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "F9": '=SUMIFS(Aggregated_Calculations!BX:BX,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "G9": "=SUM(D9:F9)",
        "D10": "=SUM(D8,D9)",
        "E10": "=SUM(E8,E9)",
        "F10": "=SUM(F8,F9)",
        "G10": "=SUM(G8,G9)",
        "D11": '=ABS(SUMIFS(Aggregated_Calculations!CC:CC,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E11": '=ABS(SUMIFS(Aggregated_Calculations!CE:CE,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F11": '=ABS(SUMIFS(Aggregated_Calculations!CG:CG,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "G11": "=SUM(D11:F11)",
        "D12": '=ABS(SUMIFS(Aggregated_Calculations!CD:CD,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E12": '=ABS(SUMIFS(Aggregated_Calculations!CF:CF,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F12": '=ABS(SUMIFS(Aggregated_Calculations!CH:CH,Aggregated_Calculations!A:A,">="&E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "G12": "=SUM(D12:F12)",
        "D13": "=SUM(D11:D12)",
        "E13": "=SUM(E11:E12)",
        "F13": "=SUM(F11:F12)",
        "G13": "=SUM(G11:G12)",
        "D14": "=Summary_WA!D17-(-Summary_WoA!D10)",
        "E14": "=Summary_WA!E17-(-Summary_WoA!E10)",
        "F14": "=Summary_WA!F17-(-Summary_WoA!F10)",
        "G14": "=Summary_WA!G17-(-Summary_WoA!G10)",
        "D15": "=D13/Summary_WA!D18",
        "E15": "=E13/Summary_WA!E18",
        "F15": "=F13/Summary_WA!F18",
        "G15": "=G13/Summary_WA!G18",
    },
}

REWA_2026_SUMMARY_FORMULAS = {
    "Final_Summary": {
        "G6": "=D6+E6+F6",
        "D7": "=(Summary_WA!D12+Summary_WA!D13)-(Summary_WA!D10+Summary_WA!D11)",
        "E7": "=(Summary_WA!E12+Summary_WA!E13)-(Summary_WA!E10+Summary_WA!E11)",
        "F7": "=(Summary_WA!F12+Summary_WA!F13)-(Summary_WA!F10+Summary_WA!F11)",
        "G7": "=(Summary_WA!G12+Summary_WA!G13)-(Summary_WA!G10+Summary_WA!G11)",
        "D8": '=IF(D7>0,"Receivable","Payable")',
        "E8": '=IF(E7>0,"Receivable","Payable")',
        "F8": '=IF(F7>0,"Receivable","Payable")',
        "G8": '=IF(G7>0,"Receivable","Payable")',
    },
    "Summary_WA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "G6": "=SUM(D6:F6)",
        "D7": "=Aggregated_Calculations!F4",
        "E7": "=Aggregated_Calculations!S4",
        "F7": "=Aggregated_Calculations!AF4",
        "G7": "=Aggregated_Calculations!AS4",
        "D8": '=SUMIFS(Aggregated_Calculations!CE:CE,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E8": '=SUMIFS(Aggregated_Calculations!CG:CG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F8": '=SUMIFS(Aggregated_Calculations!CI:CI,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G8": '=SUMIFS(Aggregated_Calculations!CC:CC,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D9": '=SUMIFS(Aggregated_Calculations!CF:CF,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!CH:CH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F9": '=SUMIFS(Aggregated_Calculations!CJ:CJ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G9": '=SUMIFS(Aggregated_Calculations!CD:CD,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D10": "=D8-D9",
        "E10": "=SUM(E8-E9)",
        "F10": "=SUM(F8-F9)",
        "G10": "=SUM(G8-G9)",
        "D11": '=SUMIFS(Aggregated_Calculations!CK:CK,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E11": '=SUMIFS(Aggregated_Calculations!CL:CL,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F11": '=SUMIFS(Aggregated_Calculations!CM:CM,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G11": "=SUM(D11:F11)",
        "D12": '=SUMIFS(Aggregated_Calculations!CN:CN,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E12": '=SUMIFS(Aggregated_Calculations!CO:CO,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F12": '=SUMIFS(Aggregated_Calculations!CP:CP,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G12": '=SUMIFS(Aggregated_Calculations!CN:CN,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)+SUMIFS(Aggregated_Calculations!CO:CO,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)+SUMIFS(Aggregated_Calculations!CP:CP,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D13": '=SUMIFS(Aggregated_Calculations!CY:CY,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E13": '=SUMIFS(Aggregated_Calculations!CZ:CZ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F13": '=SUMIFS(Aggregated_Calculations!DA:DA,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G13": '=SUMIFS(Aggregated_Calculations!CX:CX,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D14": '=SUMIFS(Aggregated_Calculations!C:C,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E14": '=SUMIFS(Aggregated_Calculations!P:P,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F14": '=SUMIFS(Aggregated_Calculations!AC:AC,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "G14": '=SUMIFS(Aggregated_Calculations!AP:AP,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "D15": '=SUMIFS(Aggregated_Calculations!D:D,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "E15": '=SUMIFS(Aggregated_Calculations!Q:Q,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "F15": '=SUMIFS(Aggregated_Calculations!AD:AD,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "G15": '=SUMIFS(Aggregated_Calculations!AQ:AQ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)*250',
        "D16": "=D15/G15",
        "E16": "=E15/G15",
        "F16": "=F15/G15",
        "G16": "=SUM(D16:F16)",
        "D17": '=SUMIFS(Aggregated_Calculations!BG:BG,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E17": '=SUMIFS(Aggregated_Calculations!BH:BH,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F17": '=SUMIFS(Aggregated_Calculations!BI:BI,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G17": '=SUMIFS(Aggregated_Calculations!BJ:BJ,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "D18": '=SUMIFS(Aggregated_Calculations!BC:BC,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "E18": '=SUMIFS(Aggregated_Calculations!BD:BD,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "F18": '=SUMIFS(Aggregated_Calculations!BE:BE,Aggregated_Calculations!A:A,">="&Summary_WA!E4,Aggregated_Calculations!A:A,"<="&Summary_WA!F4)',
        "G18": "=G15*G7",
        "D19": "=D18+Final_Summary!D7",
        "E19": "=Summary_WA!E18+Final_Summary!E7",
        "F19": "=Summary_WA!F18+Final_Summary!F7",
        "G19": "=G18+Final_Summary!G7",
        "D20": "=D10/D18",
        "E20": "=E10/E18",
        "F20": "=F10/F18",
        "G20": "=G10/G18",
    },
    "Summary_WoA": {
        "E4": "=Final_Summary!E4",
        "F4": "=Final_Summary!F4",
        "D7": "=Aggregated_Calculations!F4",
        "E7": "=Aggregated_Calculations!S4",
        "F7": "=Aggregated_Calculations!AF4",
        "D8": '=ABS(SUMIFS(Aggregated_Calculations!BK:BK,Aggregated_Calculations!A:A,">="&Final_Summary!E4,Aggregated_Calculations!A:A,"<="&Final_Summary!F4))',
        "E8": '=ABS(SUMIFS(Aggregated_Calculations!BM:BM,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F8": '=ABS(SUMIFS(Aggregated_Calculations!BO:BO,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D9": '=SUMIFS(Aggregated_Calculations!BL:BL,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "E9": '=SUMIFS(Aggregated_Calculations!BN:BN,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "F9": '=SUMIFS(Aggregated_Calculations!BP:BP,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)',
        "D10": "=SUM(D8,D9)",
        "E10": "=SUM(E8,E9)",
        "F10": "=SUM(F8,F9)",
        "D11": '=SUMIFS(Aggregated_Calculations!J:J,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)*250*Aggregated_Calculations!F4',
        "E11": '=SUMIFS(Aggregated_Calculations!W:W,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)*250*Aggregated_Calculations!S4',
        "F11": '=SUMIFS(Aggregated_Calculations!AJ:AJ,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4)*250*Aggregated_Calculations!AF4',
        "D12": '=ABS(SUMIFS(Aggregated_Calculations!BU:BU,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E12": '=ABS(SUMIFS(Aggregated_Calculations!BW:BW,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F12": '=ABS(SUMIFS(Aggregated_Calculations!BY:BY,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D13": '=ABS(SUMIFS(Aggregated_Calculations!BV:BV,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "E13": '=ABS(SUMIFS(Aggregated_Calculations!BX:BX,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "F13": '=ABS(SUMIFS(Aggregated_Calculations!BZ:BZ,Aggregated_Calculations!A:A,">="&Summary_WoA!E4,Aggregated_Calculations!A:A,"<="&Summary_WoA!F4))',
        "D14": "=SUM(D12:D13)",
        "E14": "=SUM(E12:E13)",
        "F14": "=SUM(F12:F13)",
        "D15": "=SUM(D11:D13)",
        "E15": "=SUM(E11:E13)",
        "F15": "=SUM(F11:F13)",
        "D16": "=Summary_WA!D17-(-Summary_WoA!D10)",
        "E16": "=Summary_WA!E17-(-Summary_WoA!E10)",
        "F16": "=Summary_WA!F17-(-Summary_WoA!F10)",
        "D17": "=D14/Summary_WA!D18",
        "E17": "=E14/Summary_WA!E18",
        "F17": "=F14/Summary_WA!F18",
    },
}


REWA_2014_SUMMARY_WOA_SI_UNITS = {
    "G5": "SI Units",
    "G6": "MW",
    "G7": "INR/kWh",
    "G8": "INR",
    "G9": "INR",
    "G10": "INR",
    "G11": "INR",
    "G12": "INR",
    "G13": "INR",
    "G14": "INR",
    "G15": "%",
}


@dataclass
class DsmWorkbookMapping:
    sheet_name: str
    start_row: int
    rows_per_day: int
    days: int
    date_col: str
    time_block_col: str
    generators: Dict[str, Dict[str, str]]


def _load_file_config() -> List[Dict[str, Any]]:
    if not CONFIG_FILE.exists():
        return []
    with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload if isinstance(payload, list) else []


def _merge_pss_config_defaults(config: Dict[str, Any], defaults: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(defaults or {})
    merged.update(config or {})
    for key in ("generator_defaults", "meter_split"):
        value = dict((defaults or {}).get(key) or {})
        value.update((config or {}).get(key) or {})
        merged[key] = value
    default_workbook = dict((defaults or {}).get("workbook") or {})
    workbook = dict((config or {}).get("workbook") or {})
    default_input_columns = dict(default_workbook.get("input_columns") or {})
    input_columns = dict(workbook.get("input_columns") or {})
    default_input_columns.update(input_columns)
    default_workbook.update(workbook)
    default_workbook["input_columns"] = default_input_columns
    if default_workbook:
        merged["workbook"] = default_workbook
    schedule_generators: List[str] = []
    for item in list((defaults or {}).get("schedule_generators") or []) + list((config or {}).get("schedule_generators") or []):
        code = normalize_pss_code(item)
        if code and code not in schedule_generators:
            schedule_generators.append(code)
    if schedule_generators:
        merged["schedule_generators"] = schedule_generators
    return merged


def get_pss_configs(db: Session) -> List[Dict[str, Any]]:
    rows = (
        db.query(DsmPssConfig)
        .filter(DsmPssConfig.is_active.is_(True))
        .order_by(DsmPssConfig.pss_code.asc(), DsmPssConfig.id.asc())
        .all()
    )
    if rows:
        file_defaults = {
            normalize_pss_code(item.get("pss_code")): item
            for item in _load_file_config()
            if normalize_pss_code(item.get("pss_code"))
        }
        configs: List[Dict[str, Any]] = []
        for row in rows:
            try:
                config_json = json.loads(str(row.config_json or "{}"))
            except Exception:
                config_json = {}
            merged = {
                "pss_code": row.pss_code,
                "pss_name": row.pss_name,
                "state": row.state,
                "plant_type": row.plant_type,
                "capacity_mw": row.capacity_mw,
                **(config_json if isinstance(config_json, dict) else {}),
            }
            default_cfg = file_defaults.get(normalize_pss_code(row.pss_code))
            if default_cfg:
                merged = _merge_pss_config_defaults(merged, default_cfg)
            configs.append(merged)
        return configs
    return _load_file_config()


def get_pss_config(db: Session, pss_code: str) -> Dict[str, Any]:
    code = normalize_pss_code(pss_code)
    for cfg in get_pss_configs(db):
        if normalize_pss_code(cfg.get("pss_code")) == code:
            return cfg
    raise ValueError(f"No DSM config found for pss_code={code}")


def normalize_pss_code(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or "").strip()).upper()


def _get_mapping(cfg: Dict[str, Any]) -> DsmWorkbookMapping:
    workbook = dict(cfg.get("workbook") or {})
    input_columns = dict(workbook.get("input_columns") or {})
    generators = {
        str(key): dict(value)
        for key, value in input_columns.items()
        if isinstance(value, dict)
    }
    return DsmWorkbookMapping(
        sheet_name=str(workbook.get("sheet_name") or "Aggregated_Calculations"),
        start_row=int(workbook.get("start_row") or 4),
        rows_per_day=int(workbook.get("rows_per_day") or ROWS_PER_DAY),
        days=int(workbook.get("days") or DEFAULT_DAYS),
        date_col=str(input_columns.get("date") or "A"),
        time_block_col=str(input_columns.get("time_block") or "B"),
        generators=generators,
    )


def _schedule_generators_for_config(cfg: Dict[str, Any]) -> List[str]:
    configured = cfg.get("schedule_generators")
    if not isinstance(configured, list) or not configured:
        configured = list(DEFAULT_DSM_SCHEDULE_GENERATORS)
    generators: List[str] = []
    for item in configured:
        code = normalize_pss_code(item)
        if code and code not in generators:
            generators.append(code)
    return generators or list(DEFAULT_DSM_SCHEDULE_GENERATORS)


def _schedule_file_type_for_generator(generator: str) -> str:
    return f"{normalize_pss_code(generator)}_SCHEDULE"


def _uses_extended_generators(mapping: DsmWorkbookMapping) -> bool:
    return any(
        normalize_pss_code(generator) not in set(DEFAULT_DSM_SCHEDULE_GENERATORS)
        for generator in mapping.generators
    )


def _generator_run_value(run: DsmVerificationRun, cfg: Dict[str, Any], generator: str, field: str) -> float:
    generator_code = normalize_pss_code(generator)
    attr_name = f"{generator_code.lower()}_{field}"
    value = getattr(run, attr_name, None)
    if value is not None:
        return float(value)
    default_key = "avc_mw" if field == "avc" else field
    return float((cfg.get("generator_defaults") or {}).get(generator_code, {}).get(default_key, 0) or 0)


def _generator_workbook_value(
    run: DsmVerificationRun,
    cfg: Dict[str, Any],
    generator: str,
    field: str,
    *,
    is_rewa_extended: bool = False,
) -> float:
    value = _generator_run_value(run, cfg, generator, field)
    if is_rewa_extended and field == "ppa" and normalize_pss_code(generator) == "ATHENA":
        return round(value, 2)
    return value


def _generator_header_aliases(generator: str) -> List[str]:
    code = normalize_pss_code(generator)
    aliases = {code, code.replace("_", ""), code.replace("_", " ")}
    if code == "ATHENA":
        aliases.update({"ATHENA_RUMS", "ATHENARUMS"})
    if code == "SPRNG":
        aliases.update({"SPRNG", "ARINSUN", "ARINSUN_RUMS"})
    if code == "SEIT":
        aliases.update({"SEIT", "MSRPL_REWA_RUMS_S", "MSRPLREWARUMSS"})
    return [_normalize_header(item) for item in aliases if _normalize_header(item)]


def _detect_generator_columns_from_sheet(
    sheet: Any,
    mapping: DsmWorkbookMapping,
    generator: str,
    all_generators: Sequence[str],
) -> Dict[str, str]:
    generator_code = normalize_pss_code(generator)
    aliases = _generator_header_aliases(generator_code)
    other_aliases = [
        alias
        for item in all_generators
        if normalize_pss_code(item) != generator_code
        for alias in _generator_header_aliases(item)
    ]
    if not aliases:
        return {}
    max_row = min(int(sheet.max_row or 1), max(int(mapping.start_row or 1) + 8, 30))
    max_col = int(sheet.max_column or 1)

    def cell_text(row: int, col: int) -> str:
        return _normalize_header(sheet.cell(row, col).value)

    matches: List[Tuple[int, int]] = []
    for row in range(1, max_row + 1):
        for col in range(1, max_col + 1):
            text = cell_text(row, col)
            if text and any(alias in text or text in alias for alias in aliases):
                matches.append((row, col))

    for header_row, start_col in matches:
        end_col = max_col
        for col in range(start_col + 1, max_col + 1):
            text = cell_text(header_row, col)
            if text and any(alias in text or text in alias for alias in other_aliases):
                end_col = col - 1
                break
        detected: Dict[str, str] = {}
        for col in range(start_col, end_col + 1):
            context = "".join(cell_text(row, col) for row in range(header_row, max_row + 1))
            if "schedule" in context and "schedule" not in detected:
                detected["schedule"] = get_column_letter(col)
            if any(token in context for token in ("actual", "meter")) and "actual" not in detected:
                detected["actual"] = get_column_letter(col)
            if "avc" in context and "avc" not in detected:
                detected["avc"] = get_column_letter(col)
            if "ppa" in context and "ppa" not in detected:
                detected["ppa"] = get_column_letter(col)
        if detected:
            return detected

    detected = {}
    for col in range(1, max_col + 1):
        context = "".join(cell_text(row, col) for row in range(1, max_row + 1))
        if not any(alias in context for alias in aliases):
            continue
        if "schedule" in context and "schedule" not in detected:
            detected["schedule"] = get_column_letter(col)
        if any(token in context for token in ("actual", "meter")) and "actual" not in detected:
            detected["actual"] = get_column_letter(col)
        if "avc" in context and "avc" not in detected:
            detected["avc"] = get_column_letter(col)
        if "ppa" in context and "ppa" not in detected:
            detected["ppa"] = get_column_letter(col)
    return detected


def _read_rows(filename: str, content: bytes) -> List[List[Any]]:
    lower = str(filename or "").lower()
    looks_like_xlsx = content[:4] == b"PK\x03\x04"
    if lower.endswith((".xlsx", ".xlsm", ".xltx", ".xltm")) or looks_like_xlsx:
        wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
        ws = wb.active
        return [list(row) for row in ws.iter_rows(values_only=True)]
    text = content.decode("utf-8-sig", errors="replace")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    return [list(row) for row in csv.reader(io.StringIO(text), dialect)]


def _inspect_formula_template(content: bytes) -> Tuple[int, List[str], List[str]]:
    wb = load_workbook(io.BytesIO(content), data_only=False, read_only=False)
    missing_sheets = sorted(REQUIRED_TEMPLATE_SHEETS - set(wb.sheetnames))
    missing_formulas: List[str] = []
    formula_count = 0
    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    formula_count += 1
    for sheet_name, cells in REQUIRED_TEMPLATE_FORMULA_CELLS.items():
        if sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        for cell_ref in cells:
            value = ws[cell_ref].value
            if not (isinstance(value, str) and value.startswith("=")):
                missing_formulas.append(f"{sheet_name}!{cell_ref}")
    return formula_count, missing_sheets, missing_formulas


def validate_formula_template(content: bytes) -> None:
    try:
        formula_count, missing_sheets, missing_formulas = _inspect_formula_template(content)
    except Exception as exc:
        raise ValueError(f"Unable to read calculation template workbook: {exc}") from exc
    if missing_sheets:
        raise ValueError(f"Calculation template is missing sheets: {', '.join(missing_sheets)}")
    if missing_formulas:
        raise ValueError(
            "Calculation template is missing required REWA DSM formulas: "
            + ", ".join(missing_formulas)
            + ". Upload the user-prepared REWA DSM calculation workbook, not a generated output file."
        )
    if formula_count < MIN_TEMPLATE_FORMULAS:
        raise ValueError(
            "Calculation template does not contain the required formulas. "
            "Upload the user-prepared REWA DSM calculation workbook, not a generated output file."
        )


def validate_template_shell(content: bytes) -> None:
    try:
        wb = load_workbook(io.BytesIO(content), data_only=False, read_only=False)
    except Exception as exc:
        raise ValueError(f"Unable to read calculation template workbook: {exc}") from exc
    missing_sheets = sorted(REQUIRED_TEMPLATE_SHEETS - set(wb.sheetnames))
    if missing_sheets:
        raise ValueError(f"Calculation template is missing sheets: {', '.join(missing_sheets)}")


def _validate_rewa_formula_cells(workbook_bytes: bytes) -> None:
    wb = load_workbook(io.BytesIO(workbook_bytes), data_only=False, read_only=False)
    missing: List[str] = []

    def _cell_value(ws: Any, ref: str) -> Any:
        cell = ws[ref]
        if isinstance(cell, tuple):
            first_row = cell[0] if cell else ()
            if isinstance(first_row, tuple):
                cell = first_row[0] if first_row else None
            else:
                cell = first_row
        return getattr(cell, "value", None)

    for sheet_name, cells in REQUIRED_TEMPLATE_FORMULA_CELLS.items():
        if sheet_name not in wb.sheetnames:
            missing.append(sheet_name)
            continue
        ws = wb[sheet_name]
        for cell_ref in cells:
            value = _cell_value(ws, cell_ref)
            if not (isinstance(value, str) and value.startswith("=")):
                missing.append(f"{sheet_name}!{cell_ref}")

    if missing:
        raise ValueError(
            "DSM Verification workbook is missing required formulas before recalculation: "
            + ", ".join(sorted(set(missing)))
        )


def _normalize_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _find_header_row(rows: Sequence[Sequence[Any]]) -> Tuple[int, List[str]]:
    best_index = 0
    best_headers: List[str] = [_normalize_header(cell) for cell in rows[0]] if rows else []
    best_score = -1
    for index, row in enumerate(rows[:80]):
        normalized = [_normalize_header(cell) for cell in row]
        if not any(normalized):
            continue
        has_block = any("block" in header or header in {"srno", "sno", "serialno"} for header in normalized)
        has_time = any(token in header for header in normalized for token in ("time", "timestamp", "datetime"))
        has_values = any(token in header for header in normalized for token in ("schedule", "actual", "meter", "avc", "forecast"))
        score = (100 if has_block else 0) + (80 if has_time else 0) + (60 if has_values else 0) + sum(1 for header in normalized if header)
        if score > best_score:
            best_index = index
            best_headers = normalized
            best_score = score
    return best_index, best_headers


def _as_float(value: Any) -> Optional[float]:
    if value in (None, "", "-", "--"):
        return None
    raw = str(value).strip().replace(",", "")
    try:
        out = float(raw)
    except Exception:
        return None
    if out != out or out in {float("inf"), float("-inf")}:
        return None
    return out


def _find_column(headers: Sequence[str], candidates: Iterable[str]) -> int:
    normalized = list(headers or [])
    candidate_list = [re.sub(r"[^a-z0-9]+", "", str(item or "").strip().lower()) for item in candidates if str(item or "").strip()]
    for candidate in candidate_list:
        for idx, header in enumerate(normalized):
            if header == candidate or header.endswith(candidate) or candidate in header:
                return idx
    return -1


def _meter_source_alias(value: Any) -> str:
    normalized = _normalize_header(value)
    if "barsaita" in normalized:
        return "barsaita"
    if "badwar" in normalized:
        return "badwar"
    return normalized


def _resolve_meter_columns(headers: Sequence[str], required_columns: Sequence[Any]) -> List[int]:
    resolved: List[int] = []
    for column in required_columns:
        exact = _find_column(headers, [column])
        if exact >= 0 and exact not in resolved:
            resolved.append(exact)
            continue

        alias = _meter_source_alias(column)
        if not alias:
            continue
        match = next(
            (
                idx
                for idx, header in enumerate(headers or [])
                if idx not in resolved and alias in _meter_source_alias(header)
            ),
            -1,
        )
        if match >= 0:
            resolved.append(match)
    return resolved


def _meter_headers_with_subheader(rows: Sequence[Sequence[Any]], header_index: int, headers: Sequence[str]) -> List[str]:
    resolved = list(headers or [])
    next_index = header_index + 1
    if next_index >= len(rows or []):
        return resolved
    subheader = rows[next_index] or []
    max_len = max(len(resolved), len(subheader))
    out: List[str] = []
    for idx in range(max_len):
        primary = resolved[idx] if idx < len(resolved) else ""
        secondary = _normalize_header(subheader[idx]) if idx < len(subheader) else ""
        out.append(f"{primary}{secondary}")
    return out


def parse_meter_upload(filename: str, content: bytes, mapping: Dict[str, Any]) -> Dict[int, float]:
    rows = _read_rows(filename, content)
    if not rows:
        raise ValueError("Meter file is empty")
    header_index, headers = _find_header_row(rows)
    block_index = _find_column(headers, ["block", "blockno", "blocknumber", "srno", "sno", "serialno"])
    time_index = _find_column(headers, ["timestamp", "datetime", "time"])

    values: Dict[int, float] = {}
    source_map = mapping or {}
    required_columns = list(source_map.get("source_columns") or [])
    multiplier = float(source_map.get("multiplier") or 1.0)
    if not required_columns:
        raise ValueError("Meter mapping is missing source_columns")
    column_indexes = _resolve_meter_columns(headers, required_columns)
    if len(column_indexes) != len(required_columns):
        column_indexes = _resolve_meter_columns(
            _meter_headers_with_subheader(rows, header_index, headers),
            required_columns,
        )
    if len(column_indexes) != len(required_columns):
        missing = [
            col
            for idx, col in enumerate(required_columns)
            if idx >= len(column_indexes)
        ]
        raise ValueError(f"Required meter columns not found: {', '.join(missing)}")

    for position, row in enumerate(rows[header_index + 1 :], start=1):
        block = None
        if 0 <= block_index < len(row):
            block = _as_float(row[block_index])
        if block is None and 0 <= time_index < len(row):
            time_value = str(row[time_index] or "").strip()
            match = re.search(r"(\d{1,2}):(\d{2})", time_value)
            if match:
                hour = int(match.group(1))
                minute = int(match.group(2))
                total_minutes = min((hour * 60) + minute, 1439)
                block = (total_minutes // 15) + 1
        if block is None and position <= 96:
            block = position
        if block is None:
            continue
        block_index_number = int(round(float(block)))
        if not 1 <= block_index_number <= 96:
            continue
        total = 0.0
        missing_value = False
        for idx in column_indexes:
            value = _as_float(row[idx] if idx < len(row) else None)
            if value is None:
                missing_value = True
                break
            total += value
        if missing_value:
            continue
        values[block_index_number] = total * multiplier
    if not values:
        raise ValueError("No usable meter rows found")
    return values


def parse_meter_uploads_for_generators(
    filename: str,
    content: bytes,
    meter_mapping: Dict[str, Any],
) -> Tuple[Dict[str, Dict[int, float]], List[str]]:
    parsed: Dict[str, Dict[int, float]] = {}
    errors: List[str] = []
    generators = [normalize_pss_code(key) for key in (meter_mapping or {}).keys()]
    generators = [generator for generator in generators if generator]
    if not generators:
        generators = list(DEFAULT_DSM_SCHEDULE_GENERATORS)
    for generator in generators:
        split_cfg = dict((meter_mapping or {}).get(generator) or {})
        if not split_cfg:
            errors.append(f"{generator} meter mapping missing")
            continue
        try:
            parsed[generator] = parse_meter_upload(filename, content, split_cfg)
        except Exception as exc:
            errors.append(f"{generator}: {exc}")
    if errors and not parsed:
        raise ValueError("; ".join(errors))
    return parsed, errors


def build_run_summary(run: DsmVerificationRun) -> Dict[str, Any]:
    return {
        "id": run.id,
        "pss_code": run.pss_code,
        "pss_name": run.pss_name,
        "regulation": getattr(run, "regulation", None) or "2014",
        "from_date": run.from_date.isoformat() if run.from_date else None,
        "to_date": run.to_date.isoformat() if run.to_date else None,
        "revision_number": run.revision_number,
        "status": run.status,
        "validation_status": run.validation_status,
        "template_id": run.template_id,
        "template_version": run.template_version,
        "meter_count_expected": run.meter_count_expected,
        "meter_count_uploaded": run.meter_count_uploaded,
        "schedule_sprng_count_uploaded": run.schedule_sprng_count_uploaded,
        "schedule_seit_count_uploaded": run.schedule_seit_count_uploaded,
        "schedule_athena_count_uploaded": getattr(run, "schedule_athena_count_uploaded", 0),
        "sprng_avc": float(run.sprng_avc) if run.sprng_avc is not None else None,
        "sprng_ppa": float(run.sprng_ppa) if run.sprng_ppa is not None else None,
        "seit_avc": float(run.seit_avc) if run.seit_avc is not None else None,
        "seit_ppa": float(run.seit_ppa) if run.seit_ppa is not None else None,
        "athena_avc": float(run.athena_avc) if getattr(run, "athena_avc", None) is not None else None,
        "athena_ppa": float(run.athena_ppa) if getattr(run, "athena_ppa", None) is not None else None,
        "generated_filename": run.generated_filename,
        "error_message": run.error_message,
        "created_by": run.created_by,
        "created_at": run.created_at.isoformat() if run.created_at else None,
        "completed_at": run.completed_at.isoformat() if run.completed_at else None,
    }


def normalize_regulation(value: Any) -> str:
    text = str(value or "").strip()
    return "2026" if text == "2026" else "2014"


def get_active_template_row(db: Session, pss_code: str, regulation: str = "2014") -> Optional[DsmVerificationTemplate]:
    reg = normalize_regulation(regulation)
    return (
        db.query(DsmVerificationTemplate)
        .filter(DsmVerificationTemplate.pss_code == normalize_pss_code(pss_code))
        .filter(DsmVerificationTemplate.regulation == reg)
        .filter(DsmVerificationTemplate.is_active.is_(True))
        .order_by(DsmVerificationTemplate.version.desc(), DsmVerificationTemplate.id.desc())
        .first()
    )


def get_latest_run(db: Session, pss_code: str, from_date: date, to_date: date) -> Optional[DsmVerificationRun]:
    return (
        db.query(DsmVerificationRun)
        .filter(DsmVerificationRun.pss_code == normalize_pss_code(pss_code))
        .filter(DsmVerificationRun.from_date == from_date)
        .filter(DsmVerificationRun.to_date == to_date)
        .order_by(DsmVerificationRun.revision_number.desc(), DsmVerificationRun.id.desc())
        .first()
    )


def create_run(db: Session, *, pss_code: str, from_date: date, to_date: date, created_by: str = "", force_new_revision: bool = False, regulation: str = "2014") -> DsmVerificationRun:
    cfg = get_pss_config(db, pss_code)
    code = normalize_pss_code(pss_code)
    reg = normalize_regulation(regulation)
    existing = get_latest_run(db, code, from_date, to_date)
    if existing and not force_new_revision:
        if normalize_regulation(getattr(existing, "regulation", "2014")) != reg:
            existing.regulation = reg
            db.add(existing)
            db.commit()
            db.refresh(existing)
        return existing

    revision = 1
    latest_any = (
        db.query(DsmVerificationRun)
        .filter(DsmVerificationRun.pss_code == code)
        .filter(DsmVerificationRun.from_date == from_date)
        .filter(DsmVerificationRun.to_date == to_date)
        .order_by(DsmVerificationRun.revision_number.desc(), DsmVerificationRun.id.desc())
        .first()
    )
    if latest_any:
        revision = int(latest_any.revision_number or 1) + 1

    run = DsmVerificationRun(
        pss_code=code,
        pss_name=str(cfg.get("pss_name") or code),
        regulation=reg,
        from_date=from_date,
        to_date=to_date,
        revision_number=revision,
        status="DRAFT",
        meter_count_expected=max(1, (to_date - from_date).days + 1),
        created_by=str(created_by or "").strip()[:255] or None,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def store_template(db: Session, *, pss_code: str, filename: str, mime_type: str, content: bytes, uploaded_by: str = "", regulation: str = "2014") -> DsmVerificationTemplate:
    code = normalize_pss_code(pss_code)
    reg = normalize_regulation(regulation)
    if code == "REWA":
        validate_template_shell(content)
    else:
        validate_formula_template(content)
    existing_active_for_regulation = (
        db.query(DsmVerificationTemplate)
        .filter(DsmVerificationTemplate.pss_code == code)
        .filter(DsmVerificationTemplate.regulation == reg)
        .order_by(DsmVerificationTemplate.version.desc())
        .first()
    )
    existing_version = (
        db.query(DsmVerificationTemplate)
        .filter(DsmVerificationTemplate.pss_code == code)
        .order_by(DsmVerificationTemplate.version.desc())
        .first()
    )
    version = int(existing_version.version or 0) + 1 if existing_version else 1
    checksum = sha256_bytes(content)
    if existing_active_for_regulation:
        existing_active_for_regulation.is_active = False
        db.add(existing_active_for_regulation)
    row = DsmVerificationTemplate(
        pss_code=code,
        pss_name=code,
        regulation=reg,
        original_filename=os.path.basename(filename or f"{code}_template.xlsx"),
        mime_type=mime_type or "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        file_size=len(content),
        template_binary=content,
        version=version,
        is_active=True,
        uploaded_by=str(uploaded_by or "").strip()[:255] or None,
        checksum=checksum,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def store_run_file(
    db: Session,
    *,
    run_id: int,
    file_type: str,
    generator: Optional[str],
    file_date: Optional[date],
    filename: str,
    mime_type: str,
    content: bytes,
    uploaded_by: str = "",
    parsed_json: Optional[Dict[str, Any]] = None,
) -> DsmVerificationRunFile:
    row = DsmVerificationRunFile(
        run_id=run_id,
        file_type=str(file_type or "").strip().upper(),
        generator=str(generator or "").strip().upper() or None,
        file_date=file_date,
        original_filename=os.path.basename(filename or "upload.bin"),
        mime_type=mime_type or "application/octet-stream",
        file_size=len(content),
        file_binary=content,
        checksum=sha256_bytes(content),
        uploaded_by=str(uploaded_by or "").strip()[:255] or None,
        parsed_json=json.dumps(parsed_json or {}, ensure_ascii=True, separators=(",", ":")) if parsed_json is not None else None,
        validation_status="VALID",
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def list_run_files(db: Session, run_id: int) -> List[DsmVerificationRunFile]:
    return (
        db.query(DsmVerificationRunFile)
        .filter(DsmVerificationRunFile.run_id == run_id)
        .order_by(DsmVerificationRunFile.file_date.asc().nullsfirst(), DsmVerificationRunFile.id.asc())
        .all()
    )


def delete_run_file(db: Session, run_id: int, file_id: int) -> DsmVerificationRun:
    run = db.query(DsmVerificationRun).filter(DsmVerificationRun.id == run_id).first()
    if not run:
        raise ValueError("Run not found")
    row = (
        db.query(DsmVerificationRunFile)
        .filter(DsmVerificationRunFile.run_id == run_id)
        .filter(DsmVerificationRunFile.id == file_id)
        .first()
    )
    if not row:
        raise ValueError("Run file not found")
    db.delete(row)
    db.flush()
    meter_files = db.query(DsmVerificationRunFile).filter(DsmVerificationRunFile.run_id == run.id, DsmVerificationRunFile.file_type == "METER").count()
    sprng_schedule_files = db.query(DsmVerificationRunFile).filter(DsmVerificationRunFile.run_id == run.id, DsmVerificationRunFile.file_type == "SPRNG_SCHEDULE").count()
    seit_schedule_files = db.query(DsmVerificationRunFile).filter(DsmVerificationRunFile.run_id == run.id, DsmVerificationRunFile.file_type == "SEIT_SCHEDULE").count()
    athena_schedule_files = db.query(DsmVerificationRunFile).filter(DsmVerificationRunFile.run_id == run.id, DsmVerificationRunFile.file_type == "ATHENA_SCHEDULE").count()
    run.meter_count_uploaded = meter_files
    run.schedule_sprng_count_uploaded = sprng_schedule_files
    run.schedule_seit_count_uploaded = seit_schedule_files
    run.schedule_athena_count_uploaded = athena_schedule_files
    cfg = get_pss_config(db, run.pss_code)
    run.status = "READY" if validate_run_inputs(db, run, cfg).get("ok") else "DRAFT"
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def delete_run_file_by_id(db: Session, run_id: int, file_id: int) -> DsmVerificationRun:
    return delete_run_file(db, run_id, file_id)


def _block_label(block: int) -> str:
    start_minutes = (block - 1) * 15
    end_minutes = start_minutes + 15
    start = f"{start_minutes // 60:02d}:{start_minutes % 60:02d}"
    end = f"{min(end_minutes, 1439) // 60:02d}:{min(end_minutes, 1439) % 60:02d}"
    return f"{start}-{end}"


def _normalize_report_header(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").strip().lower())


def _coerce_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    cleaned = text.replace(",", "")
    try:
        return float(cleaned)
    except ValueError:
        match = re.search(r"-?\d+(?:\.\d+)?", cleaned)
        return float(match.group(0)) if match else None


def _parse_report_date(value: Any) -> Optional[date]:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    if "T" in text:
        try:
            return datetime.fromisoformat(text.replace("Z", "+00:00")).date()
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y", "%d-%b-%Y", "%d-%b-%y", "%Y/%m/%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def _parse_report_block(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        return int(value) if value > 0 else None
    text = str(value or "").strip()
    if not text:
        return None
    if re.fullmatch(r"\d+(?:\.0+)?", text):
        number = int(float(text))
        return number if number > 0 else None
    if "-" in text and ":" in text:
        start = text.split("-", 1)[0].strip()
        if re.fullmatch(r"\d{1,2}:\d{2}", start):
            hour, minute = [int(part) for part in start.split(":", 1)]
            if hour == 24:
                hour = 0
            block = int((hour * 60 + minute) / 15) + 1
            return block if block > 0 else None
    match = re.search(r"\d+", text)
    if match:
        number = int(match.group(0))
        return number if number > 0 else None
    return None


def _sorted_official_report_dates(official_report_data: Optional[Dict[str, Dict[str, Dict[str, Any]]]]) -> List[date]:
    if not official_report_data:
        return []
    out: List[date] = []
    for key in official_report_data.keys():
        parsed = _parse_report_date(key)
        if parsed:
            out.append(parsed)
    return sorted(set(out))


def _lookup_report_column(column_map: Dict[str, int], *candidates: str) -> Optional[int]:
    for candidate in candidates:
        key = _normalize_report_header(candidate)
        if key in column_map:
            return column_map[key]
    return None


def _normalize_rewa_schedule_values(values: Dict[int, float]) -> Dict[int, float]:
    # REWA schedule workbooks in this flow use the opposite sign convention from
    # the office calculation template. Keep the parser local to this screen and
    # normalize the schedule series only for REWA so the template formulas see
    # the same positive schedule values as the office sheet.
    return {int(block): abs(float(amount or 0)) for block, amount in values.items()}


def parse_official_report_upload(filename: str, content: bytes) -> Dict[str, Any]:
    rows = _read_rows(filename, content)
    header_index = None
    column_map: Dict[str, int] = {}
    for idx, row in enumerate(rows):
        normalized = [_normalize_report_header(cell) for cell in row]
        if not any(normalized):
            continue
        if "date" in normalized and ("block" in normalized or "timeblock" in normalized or "time_block" in normalized):
            header_index = idx
            column_map = {name: pos for pos, name in enumerate(normalized) if name}
            break
    if header_index is None:
        raise ValueError("Official DSM report header row not found")

    date_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["date"])
    block_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["block"])
    actual_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["actual_mwh"])
    schedule_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["schedule_mwh"])
    avc_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["avc_mwh"])
    ppa_col = _lookup_report_column(column_map, *OFFICIAL_REPORT_COLUMN_ALIASES["ppa_pmwh"])
    if date_col is None or block_col is None:
        raise ValueError("Official DSM report requires date and block columns")

    parsed_rows: List[Dict[str, Any]] = []
    blocks_by_date: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for raw_row in rows[header_index + 1 :]:
        if not any(str(cell or "").strip() for cell in raw_row):
            continue
        row_date = _parse_report_date(raw_row[date_col]) if date_col < len(raw_row) else None
        row_block = _parse_report_block(raw_row[block_col]) if block_col < len(raw_row) else None
        if not row_date or not row_block:
            continue
        actual_mwh = _coerce_float(raw_row[actual_col]) if actual_col is not None and actual_col < len(raw_row) else None
        schedule_mwh = _coerce_float(raw_row[schedule_col]) if schedule_col is not None and schedule_col < len(raw_row) else None
        avc_mwh = _coerce_float(raw_row[avc_col]) if avc_col is not None and avc_col < len(raw_row) else None
        ppa_pmwh = _coerce_float(raw_row[ppa_col]) if ppa_col is not None and ppa_col < len(raw_row) else None
        record = {
            "date": row_date.isoformat(),
            "block": int(row_block),
            "actual_mw": round((actual_mwh or 0.0) * OFFICIAL_REPORT_MWH_TO_MW_MULTIPLIER, 6),
            "schedule_mw": round((schedule_mwh or 0.0) * OFFICIAL_REPORT_MWH_TO_MW_MULTIPLIER, 6),
            "avc_mw": round((avc_mwh or 0.0) * OFFICIAL_REPORT_MWH_TO_MW_MULTIPLIER, 6),
            "weighted_average_ppa": round((ppa_pmwh or 0.0) / OFFICIAL_REPORT_PPA_DIVISOR, 6),
        }
        parsed_rows.append(record)
        blocks_by_date.setdefault(record["date"], {})[str(record["block"])] = record

    if not parsed_rows:
        raise ValueError("Official DSM report did not contain any usable block rows")

    return {
        "source_filename": os.path.basename(filename or "official_dsm_report"),
        "rows": parsed_rows,
        "blocks": blocks_by_date,
    }


def _translate_formula(formula: str, origin: str, target: str) -> str:
    return Translator(formula, origin=origin).translate_formula(target)


REWA_2026_FREQ_TRAS_SHEET = "Freq&TRAS"
REWA_2026_FREQ_TRAS_START_ROW = 4
REWA_2026_FREQ_TRAS_DATE_COL = "A"
REWA_2026_FREQ_TRAS_TIME_BLOCK_COL = "B"


def _populate_rewa_2026_freq_tras_dates(wb: Any, *, run: DsmVerificationRun, rows_per_day: int) -> None:
    if REWA_2026_FREQ_TRAS_SHEET not in wb.sheetnames:
        return
    ws = wb[REWA_2026_FREQ_TRAS_SHEET]
    total_days = max(1, (run.to_date - run.from_date).days + 1)
    for day_index in range(total_days):
        current_date = run.from_date + timedelta(days=day_index)
        for block in range(1, rows_per_day + 1):
            row = REWA_2026_FREQ_TRAS_START_ROW + (day_index * rows_per_day) + block - 1
            ws[f"{REWA_2026_FREQ_TRAS_DATE_COL}{row}"] = current_date
            ws[f"{REWA_2026_FREQ_TRAS_TIME_BLOCK_COL}{row}"] = _block_label(block)


def _capture_template_formulas(wb: Any, *, mapping: DsmWorkbookMapping) -> Dict[str, Dict[str, str]]:
    formulas: Dict[str, Dict[str, str]] = {}
    for ws in wb.worksheets:
        sheet_formulas: Dict[str, str] = {}
        if ws.title == mapping.sheet_name:
            for cell in ws[mapping.start_row]:
                if isinstance(cell.value, str) and cell.value.startswith("="):
                    sheet_formulas[cell.coordinate] = cell.value
        else:
            for row in ws.iter_rows():
                for cell in row:
                    if isinstance(cell.value, str) and cell.value.startswith("="):
                        sheet_formulas[cell.coordinate] = cell.value
        if sheet_formulas:
            formulas[ws.title] = sheet_formulas
    return formulas


def _apply_template_formulas(
    wb: Any,
    *,
    mapping: DsmWorkbookMapping,
    run: DsmVerificationRun,
    template_formulas: Dict[str, Dict[str, str]],
    official_report_data: Optional[Dict[str, Dict[str, Dict[str, Any]]]] = None,
) -> None:
    is_rewa = normalize_pss_code(run.pss_code) == "REWA"
    uses_extended_generators = _uses_extended_generators(mapping)
    is_rewa_2026 = is_rewa and uses_extended_generators and normalize_regulation(getattr(run, "regulation", "2014")) == "2026"
    official_dates = _sorted_official_report_dates(official_report_data)
    official_start = official_dates[0] if official_dates else run.from_date
    official_end = official_dates[-1] if official_dates else run.to_date
    summary_avc_values = {
        "D": float(run.sprng_avc or 0),
        "E": float(run.seit_avc or 0),
    }
    if uses_extended_generators:
        summary_avc_values["F"] = _generator_run_value(run, {}, "ATHENA", "avc")

    def apply_summary_defaults(sheet_name: str, formulas: Dict[str, str], *, overwrite: bool) -> None:
        if sheet_name not in wb.sheetnames:
            return
        ws = wb[sheet_name]
        for coordinate, formula in formulas.items():
            current = ws[coordinate].value
            if overwrite or not (isinstance(current, str) and current.startswith("=")):
                ws[coordinate] = formula

    if "Final_Summary" in wb.sheetnames:
        ws = wb["Final_Summary"]
        ws["E4"] = official_start
        ws["F4"] = official_end
        if is_rewa:
            for column, value in summary_avc_values.items():
                ws[f"{column}6"] = value
    for sheet_name in ("Summary_WA", "Summary_WoA"):
        if sheet_name in wb.sheetnames:
            ws = wb[sheet_name]
            if is_rewa:
                for column, value in summary_avc_values.items():
                    ws[f"{column}6"] = value
            if not uses_extended_generators:
                if sheet_name == "Summary_WA":
                    ws["D7"] = float(run.sprng_ppa or 0)
                    ws["E7"] = float(run.seit_ppa or 0)

    for sheet_name, formulas in template_formulas.items():
        if sheet_name == mapping.sheet_name or sheet_name not in wb.sheetnames:
            continue
        ws = wb[sheet_name]
        for coordinate, formula in formulas.items():
            ws[coordinate] = formula

    if is_rewa and not uses_extended_generators:
        for sheet_name, formulas in REWA_SUMMARY_FORMULAS.items():
            apply_summary_defaults(sheet_name, formulas, overwrite=True)
    elif is_rewa and uses_extended_generators:
        summary_formulas = REWA_2026_SUMMARY_FORMULAS if is_rewa_2026 else REWA_EXTENDED_SUMMARY_FORMULAS
        for sheet_name, formulas in summary_formulas.items():
            apply_summary_defaults(sheet_name, formulas, overwrite=False)
        if is_rewa_2026:
            _populate_rewa_2026_freq_tras_dates(wb, run=run, rows_per_day=mapping.rows_per_day)
        elif "Summary_WoA" in wb.sheetnames:
            ws = wb["Summary_WoA"]
            for coordinate, value in REWA_2014_SUMMARY_WOA_SI_UNITS.items():
                ws[coordinate] = value

    ws = wb[mapping.sheet_name] if mapping.sheet_name in wb.sheetnames else wb.active
    source_formulas = template_formulas.get(ws.title) or {}
    rewa_extended_input_columns = set(REWA_2026_INPUT_COLUMNS if is_rewa_2026 else REWA_EXTENDED_INPUT_COLUMNS)
    if is_rewa and uses_extended_generators:
        for cols in mapping.generators.values():
            for field in ("schedule", "actual", "avc", "ppa"):
                column = str(cols.get(field) or "").strip().upper()
                if column:
                    rewa_extended_input_columns.add(column)
    if is_rewa and not uses_extended_generators:
        source_formulas = {f"{column}{mapping.start_row}": formula for column, formula in REWA_AGGREGATED_ROW4_FORMULAS.items()}
    elif is_rewa and uses_extended_generators and not is_rewa_2026:
        fallback_formulas = {f"{column}{mapping.start_row}": formula for column, formula in REWA_EXTENDED_AGGREGATED_ROW4_FORMULAS.items()}
        fallback_formulas.update(
            {
                coordinate: formula
                for coordinate, formula in source_formulas.items()
                if (re.match(r"([A-Z]+)", coordinate) and re.match(r"([A-Z]+)", coordinate).group(1) not in rewa_extended_input_columns)
            }
        )
        source_formulas = fallback_formulas
    row_count = max(1, (run.to_date - run.from_date).days + 1) * mapping.rows_per_day
    for row in range(mapping.start_row, mapping.start_row + row_count):
        day_index = (row - mapping.start_row) // mapping.rows_per_day
        row_date = official_dates[day_index] if day_index < len(official_dates) else (run.from_date + timedelta(days=day_index))
        ws[f"{mapping.date_col}{row}"] = row_date
        row_block = _parse_report_block(ws[f"{mapping.time_block_col}{row}"].value)
        official_row = None
        if official_report_data and row_date and row_block:
            date_key = row_date.isoformat()
            official_row = (official_report_data.get(date_key) or {}).get(str(int(row_block)))
        if uses_extended_generators and is_rewa_2026:
            if official_row:
                ws[f"AP{row}"] = float(official_row.get("schedule_mw") or 0)
                ws[f"AQ{row}"] = float(official_row.get("actual_mw") or 0)
                ws[f"AR{row}"] = float(official_row.get("avc_mw") or 0)
                ws[f"AS{row}"] = float(official_row.get("weighted_average_ppa") or 0)
            else:
                ws[f"AP{row}"] = f"=SUM(C{row},P{row},AC{row})"
                ws[f"AQ{row}"] = f"=SUM(D{row},Q{row},AD{row})"
                ws[f"AR{row}"] = f"=SUM(E{row},R{row},AE{row})"
                ws[f"AS{row}"] = f"=AVERAGE(F{row},S{row},AF{row})"
        elif uses_extended_generators and is_rewa:
            if official_row:
                ws[f"AV{row}"] = float(official_row.get("schedule_mw") or 0)
                ws[f"AW{row}"] = float(official_row.get("actual_mw") or 0)
                ws[f"AX{row}"] = float(official_row.get("avc_mw") or 0)
                ws[f"AY{row}"] = float(official_row.get("weighted_average_ppa") or 0)
            else:
                ws[f"AV{row}"] = f"=SUM(C{row},R{row},AG{row})"
                ws[f"AW{row}"] = f"=SUM(D{row},S{row},AH{row})"
                ws[f"AX{row}"] = f"=SUM(E{row},T{row},AI{row})"
                ws[f"AY{row}"] = f"=AVERAGE(F{row},U{row},AJ{row})"
        elif uses_extended_generators:
            pass
        elif official_row:
            ws[f"AG{row}"] = float(official_row.get("schedule_mw") or 0)
            ws[f"AH{row}"] = float(official_row.get("actual_mw") or 0)
            ws[f"AI{row}"] = float(official_row.get("avc_mw") or 0)
            ws[f"AJ{row}"] = float(official_row.get("weighted_average_ppa") or 0)
        else:
            ws[f"AG{row}"] = f"=SUM(C{row},R{row})"
            ws[f"AH{row}"] = f"=SUM(D{row},S{row})"
            ws[f"AI{row}"] = f"=SUM(E{row},T{row})"
            ws[f"AJ{row}"] = f"=AVERAGE(F{row},U{row})"
        for origin, formula in source_formulas.items():
            source_col = re.match(r"([A-Z]+)", origin)
            if not source_col:
                continue
            target = f"{source_col.group(1)}{row}"
            if is_rewa and uses_extended_generators and source_col.group(1) in rewa_extended_input_columns:
                continue
            ws[target] = _translate_formula(formula, origin, target)


def _populate_workbook(
    wb: Any,
    *,
    cfg: Dict[str, Any],
    run: DsmVerificationRun,
    schedules_by_generator: Dict[str, Dict[date, Dict[int, float]]],
    actuals_by_generator: Dict[str, Dict[date, Dict[int, float]]],
    official_report_data: Optional[Dict[str, Dict[str, Dict[str, Any]]]] = None,
) -> bytes:
    mapping = _get_mapping(cfg)
    template_formulas = _capture_template_formulas(wb, mapping=mapping)
    ws = wb[mapping.sheet_name] if mapping.sheet_name in wb.sheetnames else wb.active
    configured_generators = _schedule_generators_for_config(cfg)
    for generator in configured_generators:
        detected_cols = _detect_generator_columns_from_sheet(ws, mapping, generator, configured_generators)
        if detected_cols:
            existing_cols = dict(mapping.generators.get(generator) or {})
            existing_cols.update(detected_cols)
            mapping.generators[generator] = existing_cols
    is_rewa_extended = normalize_pss_code(run.pss_code) == "REWA" and _uses_extended_generators(mapping)
    start = run.from_date
    for day_index in range(max(1, (run.to_date - run.from_date).days + 1)):
        current_date = start + timedelta(days=day_index)
        for block in range(1, mapping.rows_per_day + 1):
            row = mapping.start_row + (day_index * mapping.rows_per_day) + block - 1
            ws[f"{mapping.date_col}{row}"] = current_date
            ws[f"{mapping.time_block_col}{row}"] = _block_label(block)

            for generator, cols in mapping.generators.items():
                generator_code = normalize_pss_code(generator)
                schedule_col = cols.get("schedule")
                actual_col = cols.get("actual")
                avc_col = cols.get("avc")
                ppa_col = cols.get("ppa")
                if schedule_col:
                    ws[f"{schedule_col}{row}"] = float(((schedules_by_generator.get(generator_code) or {}).get(current_date) or {}).get(block) or 0)
                if actual_col:
                    ws[f"{actual_col}{row}"] = float(((actuals_by_generator.get(generator_code) or {}).get(current_date) or {}).get(block) or 0)
                if avc_col:
                    ws[f"{avc_col}{row}"] = _generator_workbook_value(
                        run,
                        cfg,
                        generator_code,
                        "avc",
                        is_rewa_extended=is_rewa_extended,
                    )
                if ppa_col:
                    ws[f"{ppa_col}{row}"] = _generator_workbook_value(
                        run,
                        cfg,
                        generator_code,
                        "ppa",
                        is_rewa_extended=is_rewa_extended,
                    )

    _apply_template_formulas(
        wb,
        mapping=mapping,
        run=run,
        template_formulas=template_formulas,
        official_report_data=official_report_data,
    )

    try:
        wb.calculation.fullCalcOnLoad = True
        wb.calculation.forceFullCalc = True
        wb.calculation.calcMode = "auto"
        wb.calculation.calcId = 0
    except Exception:
        pass

    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _parse_input_files_for_run(
    db: Session,
    run: DsmVerificationRun,
    cfg: Dict[str, Any],
) -> Tuple[
    Dict[str, Dict[date, Dict[int, float]]],
    Dict[str, Dict[date, Dict[int, float]]],
    Dict[str, Dict[str, Dict[str, Any]]],
    List[str],
]:
    files = list_run_files(db, run.id)
    meter_mapping = dict(cfg.get("meter_split") or {})
    schedule_generators = _schedule_generators_for_config(cfg)
    schedules_by_generator: Dict[str, Dict[date, Dict[int, float]]] = {generator: {} for generator in schedule_generators}
    actuals_by_generator: Dict[str, Dict[date, Dict[int, float]]] = {generator: {} for generator in schedule_generators}
    official_report_data: Dict[str, Dict[str, Dict[str, Any]]] = {}
    file_errors: List[str] = []
    for file_row in files:
        try:
            if file_row.file_type == "METER":
                if not file_row.file_date:
                    raise ValueError("Meter file date missing")
                parsed, meter_errors = parse_meter_uploads_for_generators(file_row.original_filename, file_row.file_binary, meter_mapping)
                for generator, blocks in parsed.items():
                    generator_code = normalize_pss_code(generator)
                    if generator_code in actuals_by_generator:
                        actuals_by_generator[generator_code][file_row.file_date] = blocks
                if meter_errors:
                    file_errors.append(f"METER {file_row.file_date}: {'; '.join(meter_errors)}")
            elif str(file_row.file_type or "").endswith("_SCHEDULE"):
                generator_code = normalize_pss_code(str(file_row.file_type or "")[: -len("_SCHEDULE")])
                if generator_code not in schedules_by_generator:
                    continue
                if not file_row.file_date:
                    raise ValueError(f"{generator_code} schedule date missing")
                parsed = parse_schedule_upload(file_row.original_filename, file_row.file_binary, "REWA")
                parsed = _normalize_rewa_schedule_values(parsed) if normalize_pss_code(run.pss_code) == "REWA" else parsed
                schedules_by_generator[generator_code][file_row.file_date] = parsed
            elif file_row.file_type == "OFFICIAL_REFERENCE":
                parsed_payload: Dict[str, Any] = {}
                if file_row.parsed_json:
                    try:
                        parsed_payload = json.loads(file_row.parsed_json) if isinstance(file_row.parsed_json, str) else dict(file_row.parsed_json)
                    except Exception:
                        parsed_payload = {}
                if not parsed_payload or "blocks" not in parsed_payload:
                    parsed_payload = parse_official_report_upload(file_row.original_filename, file_row.file_binary)
                for date_key, day_blocks in (parsed_payload.get("blocks") or {}).items():
                    if not isinstance(day_blocks, dict):
                        continue
                    official_report_data.setdefault(str(date_key), {})
                    for block_key, block_value in day_blocks.items():
                        if not isinstance(block_value, dict):
                            continue
                        official_report_data[str(date_key)][str(block_key)] = block_value
        except Exception as exc:
            file_errors.append(f"{file_row.file_type} {file_row.file_date or ''}: {exc}")
    return schedules_by_generator, actuals_by_generator, official_report_data, file_errors


def validate_run_inputs(db: Session, run: DsmVerificationRun, cfg: Dict[str, Any]) -> Dict[str, Any]:
    files = list_run_files(db, run.id)
    missing: List[str] = []
    schedule_generators = _schedule_generators_for_config(cfg)
    meter_dates = {f.file_date for f in files if f.file_type == "METER" and f.file_date}
    expected_dates = {run.from_date + timedelta(days=i) for i in range((run.to_date - run.from_date).days + 1)}
    meter_missing = sorted(expected_dates - meter_dates)
    if meter_missing:
        for d in meter_missing:
            missing.append(f"Meter Data\n{d.strftime('%d-%b-%Y')}")
    for generator in schedule_generators:
        generator_dates = {f.file_date for f in files if f.file_type == _schedule_file_type_for_generator(generator) and f.file_date}
        for d in sorted(expected_dates - generator_dates):
            missing.append(f"{generator} Schedule\n{d.strftime('%d-%b-%Y')}")
        if getattr(run, f"{generator.lower()}_avc", None) is None:
            missing.append(f"{generator} AVC")
        if getattr(run, f"{generator.lower()}_ppa", None) is None:
            missing.append(f"{generator} PPA")
    template = get_active_template_row(db, run.pss_code, getattr(run, "regulation", "2014"))
    if not template:
        missing.append("Active calculation template")
    return {"ok": not missing, "missing": missing}


def generate_run_workbook(db: Session, run_id: int, regulation: Optional[str] = None) -> DsmVerificationRun:
    run = db.query(DsmVerificationRun).filter(DsmVerificationRun.id == run_id).first()
    if not run:
        raise ValueError("Run not found")
    if regulation is not None:
        run.regulation = normalize_regulation(regulation)
        db.add(run)
        db.commit()
        db.refresh(run)
    cfg = get_pss_config(db, run.pss_code)
    template = get_active_template_row(db, run.pss_code, getattr(run, "regulation", "2014"))
    if not template:
        raise ValueError("Active calculation template not found")

    validation = validate_run_inputs(db, run, cfg)
    if not validation["ok"]:
        run.status = "FAILED"
        run.error_message = "Verification cannot be generated.\n\nMissing:\n\n" + "\n".join(validation["missing"])
        db.add(run)
        db.commit()
        raise ValueError("Verification cannot be generated.\n\nMissing:\n\n" + "\n".join(validation["missing"]))

    try:
        run.status = "CALCULATING"
        run.template_id = template.id
        run.template_version = template.version
        db.add(run)
        db.commit()
        schedules_by_generator, actuals_by_generator, official_report_data, parse_errors = _parse_input_files_for_run(db, run, cfg)
        if parse_errors:
            raise ValueError("; ".join(parse_errors))
        if normalize_pss_code(run.pss_code) != "REWA":
            validate_formula_template(template.template_binary)
        else:
            validate_template_shell(template.template_binary)
        wb = load_workbook(io.BytesIO(template.template_binary))
    except Exception as exc:
        run.status = "FAILED"
        run.error_message = str(exc)
        db.add(run)
        db.commit()
        raise ValueError(f"Failed to load calculation template: {exc}") from exc

    try:
        generated_bytes = _populate_workbook(
            wb,
            cfg=cfg,
            run=run,
            schedules_by_generator=schedules_by_generator,
            actuals_by_generator=actuals_by_generator,
            official_report_data=official_report_data,
        )
        mapping = _get_mapping(cfg)
        uses_extended_generators = _uses_extended_generators(mapping)
        is_rewa_run = normalize_pss_code(run.pss_code) == "REWA"
        if is_rewa_run:
            _validate_rewa_formula_cells(generated_bytes)

        with tempfile.TemporaryDirectory(prefix="dsm_verification_") as temp_dir_name:
            temp_dir = Path(temp_dir_name)
            source_path = temp_dir / "verification_input.xlsx"
            recalculated_path = temp_dir / "verification_output.xlsx"
            source_path.write_bytes(generated_bytes)
            LOGGER.info("DSM Verification: Starting Excel recalculation for run %s", run.id)
            recalculation_required_cells = {"Final_Summary": ("D7", "E7", "F7")} if is_rewa_run else None
            recalculate_excel_workbook(
                source_path,
                recalculated_path,
                required_final_charge_cells=recalculation_required_cells,
                allow_formula_fallback=is_rewa_run,
            )
            LOGGER.info("DSM Verification: Recalculation completed for run %s", run.id)
            generated_bytes = recalculated_path.read_bytes()
    except Exception as exc:
        run.status = "FAILED"
        run.error_message = str(exc)
        db.add(run)
        db.commit()
        raise ValueError(f"Failed to generate recalculated workbook: {exc}") from exc

    regulation_label = normalize_regulation(getattr(run, "regulation", "2014"))
    filename = f"{run.pss_code}_DSM_Verification({regulation_label})_{run.from_date.isoformat()}_to_{run.to_date.isoformat()}.xlsx"
    run.generated_filename = filename
    run.generated_mime_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    run.generated_file_size = len(generated_bytes)
    run.generated_binary = generated_bytes
    run.generated_checksum = sha256_bytes(generated_bytes)
    run.status = "COMPLETED"
    run.completed_at = datetime.utcnow()
    run.error_message = None
    db.add(run)
    db.commit()
    db.refresh(run)
    return run
