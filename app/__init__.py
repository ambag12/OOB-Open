"""Hosted, multi-user front end for the out-of-budget analysis.

`app.services` holds the analysis and export code, and imports nothing but the
standard library and `ppcbudget` -- that is what lets serve.py keep running
offline with no third-party dependencies beyond openpyxl.

Everything else in this package is the web application: FastAPI routers, the
MySQL-backed account store, and the per-user workspaces.
"""

__version__ = "2.0.0"
