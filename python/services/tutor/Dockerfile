FROM python:3.11-slim

WORKDIR /app

# Install system dependencies required by OpenCV (cv2)
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Expose port
EXPOSE 5002

# Run FastAPI app with uvicorn bound to 0.0.0.0 so it is accessible outside the container
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5002"]
