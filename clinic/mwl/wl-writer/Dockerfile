FROM python:3.12-slim
# Pinned: pydicom 3.x replaced write_like_original with enforce_file_format.
RUN pip install --no-cache-dir pydicom==2.4.4
WORKDIR /app
COPY app.py .
EXPOSE 8500
CMD ["python", "-u", "app.py"]
