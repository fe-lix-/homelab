FROM python:3.12-slim

RUN pip install --no-cache-dir 'pywidevine[serve]==1.8.0'

EXPOSE 8786
ENTRYPOINT ["pywidevine"]
CMD ["serve", "--host", "0.0.0.0", "--port", "8786", "/config/serve.yml"]
