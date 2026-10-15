Try a different search term, or [contact support](mailto:support@typesafe.ai).

[Check system status](https://status.typesafe.ai/)

# What is the difference between 429 and 529?

**429 Too Many Requests** means your request exceeded a rate limit. **529 Overloaded** means TypeSafe is temporarily overloaded.

## What to try

Retry with exponential backoff instead of retrying immediately. Honor a retry-after header when one is returned.

If you use a TypeSafe SDK, check its retry configuration. The default policy already handles backoff; avoid adding another retry loop without checking the existing behavior.

For repeated 429s, reduce request bursts or concurrency and review the current [model limits](https://docs.typesafe.ai/models). For repeated 529s, check [system status](https://status.typesafe.ai/).

## If requests keep failing

Email [support@typesafe.ai](mailto:support@typesafe.ai) with the organization name and ID if available, model, status code, request ID if shown, timestamps and time zone, approximate request rate, and SDK version. Include what you already tried.

Do not send API keys or sensitive request contents. A higher rate limit is not a guaranteed fix for overload.

See the [API reference](https://docs.typesafe.ai/api) for current error and retry behavior.
