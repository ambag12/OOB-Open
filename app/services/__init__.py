"""Framework-free services.

`analysis` and `exporters` deliberately import nothing beyond the standard
library and `ppcbudget`, so that the local single-user serve.py can use them
without pulling in FastAPI, SQLAlchemy or anything else.
"""
