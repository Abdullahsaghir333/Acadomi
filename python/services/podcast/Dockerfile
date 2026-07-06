FROM python:3.12-slim

WORKDIR /app

# Install system dependencies (ffmpeg is required by pydub for audio processing)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies (including gunicorn for production WSGI server)
COPY requirements.txt .
RUN pip install --no-cache-dir gunicorn && \
    pip install --no-cache-dir -r requirements.txt

# Copy the source code
COPY . .

# Expose the Flask port
EXPOSE 5001

# Run with gunicorn bound to 0.0.0.0 so it is accessible outside the container, with an increased timeout for long audio tasks
CMD ["gunicorn", "--bind", "0.0.0.0:5001", "--timeout", "300", "app:app"]
