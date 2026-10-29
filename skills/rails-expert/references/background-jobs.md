# Background Jobs with Sidekiq

## Sidekiq Setup

```ruby
# Gemfile
gem 'sidekiq'
gem 'sidekiq-cron' # Optional: scheduled jobs

# config/initializers/sidekiq.rb
Sidekiq.configure_server do |config|
  config.redis = { url: ENV['REDIS_URL'] || 'redis://localhost:6379/0' }
end

Sidekiq.configure_client do |config|
  config.redis = { url: ENV['REDIS_URL'] || 'redis://localhost:6379/0' }
end

# config/sidekiq.yml
:concurrency: 5
:queues:
  - critical
  - default
  - low
```

## Basic Job Design

```ruby
# app/jobs/email_sender_job.rb
class EmailSenderJob < ApplicationJob
  queue_as :default

  def perform(user_id, email_type)
    user = User.find(user_id)
    UserMailer.public_send(email_type, user).deliver_now # allowlist email_type before calling
  end
end

# Usage
EmailSenderJob.perform_later(user.id, :welcome)

# Perform at specific time
EmailSenderJob.set(wait: 1.hour).perform_later(user.id, :reminder)
EmailSenderJob.set(wait_until: Date.tomorrow.noon).perform_later(user.id, :digest)
```

## Queue Priority

```ruby
class CriticalJob < ApplicationJob
  queue_as :critical

  def perform
    # High priority work
  end
end

class ReportGenerationJob < ApplicationJob
  queue_as :low

  def perform
    # Can wait
  end
end
```

## Retry Strategy

```ruby
class ImportJob < ApplicationJob
  # ActiveJob API: sidekiq_options / sidekiq_retry_in only work on a plain `include Sidekiq::Job` class
  retry_on NetworkError, wait: ->(executions) { 10 * executions }, attempts: 5 # 10, 20, 30... seconds
  retry_on RateLimitError, wait: 1.hour, attempts: 5
  discard_on ActiveJob::DeserializationError

  def perform(data_url)
    # Import logic
  end
end
```

## Error Handling

```ruby
class ProcessPaymentJob < ApplicationJob
  retry_on PaymentError, attempts: 3

  # Called when the job is discarded after all retries (Rails 7.1+); on a plain Sidekiq::Job use sidekiq_retries_exhausted
  after_discard do |job, exception|
    Rails.logger.error("Payment job failed: #{job.arguments}")

    # Notify admin
    AdminMailer.job_failed(job.arguments, exception).deliver_now

    # Store failure record
    FailedPayment.create(
      user_id: job.arguments[0],
      error: exception.message
    )
  end

  def perform(user_id, amount)
    user = User.find(user_id)
    # Retries can charge twice: pass an idempotency key (e.g. job_id) so the processor ignores duplicates
    PaymentProcessor.charge(user, amount, idempotency_key: job_id)
  rescue PaymentError => e
    # Log and re-raise to trigger retry
    Rails.logger.warn("Payment failed: #{e.message}")
    raise
  end
end
```

## Batch Processing

```ruby
class BulkEmailJob < ApplicationJob
  def perform(user_ids)
    # Process in batches to avoid memory issues
    user_ids.in_groups_of(100, false) do |batch|
      batch.each do |user_id|
        user = User.find(user_id)
        UserMailer.newsletter(user).deliver_now
      end
    end
  end
end

# Better: Use Sidekiq::Batch (requires sidekiq-pro)
class ParentJob < ApplicationJob
  def perform(user_ids)
    batch = Sidekiq::Batch.new
    batch.on(:success, self.class, 'user_ids' => user_ids)

    batch.jobs do
      user_ids.each do |user_id|
        ChildJob.perform_later(user_id)
      end
    end
  end

  def on_success(status, options)
    # All child jobs completed
    Rails.logger.info("Processed #{options['user_ids'].length} users")
  end
end
```

## Scheduled Jobs

```ruby
# Using sidekiq-cron
# config/initializers/sidekiq.rb
schedule_file = "config/schedule.yml"

if File.exist?(schedule_file) && Sidekiq.server?
  Sidekiq::Cron::Job.load_from_hash YAML.load_file(schedule_file)
end

# config/schedule.yml
daily_report:
  cron: "0 6 * * *"
  class: "DailyReportJob"
  queue: default

cleanup_old_records:
  cron: "0 2 * * 0" # Sunday at 2am
  class: "CleanupJob"
  queue: low
```

## Job Patterns

Idempotent jobs:

```ruby
class ProcessOrderJob < ApplicationJob
  def perform(order_id)
    order = Order.find(order_id)

    # Check if already processed
    return if order.processed?

    # Process order
    order.process!
  end
end
```

Unique jobs (requires sidekiq-unique-jobs gem):

```ruby
class GenerateReportJob
  include Sidekiq::Job # plain Sidekiq job; sidekiq_options is not available on ApplicationJob
  sidekiq_options lock: :until_executed,
                   on_conflict: :log

  def perform(user_id, report_type)
    # Only one instance of this job per user+report_type
  end
end
```

## Testing

```ruby
# spec/jobs/email_sender_job_spec.rb
require 'rails_helper'

RSpec.describe EmailSenderJob, type: :job do
  let(:user) { create(:user) }

  describe "#perform" do
    it "sends welcome email" do
      expect {
        described_class.perform_now(user.id, :welcome)
      }.to change { ActionMailer::Base.deliveries.count }.by(1)
    end

    it "enqueues job" do
      expect {
        described_class.perform_later(user.id, :welcome)
      }.to have_enqueued_job(described_class)
        .with(user.id, :welcome)
        .on_queue("default")
    end
  end
end

# Run jobs inline in development (use :test in config/environments/test.rb for assertions)
# config/environments/development.rb
config.active_job.queue_adapter = :inline
```

## Monitoring

```ruby
# Check queue size
Sidekiq::Queue.new("default").size

# Check scheduled jobs
Sidekiq::ScheduledSet.new.size

# Check retry set
Sidekiq::RetrySet.new.size

# Check dead jobs
Sidekiq::DeadSet.new.size

# Clear queues (use with caution)
Sidekiq::Queue.new("default").clear
```

## Performance Tips

- Keep jobs small and focused
- Pass IDs, not objects (serialize/deserialize issue)
- Use appropriate queue priorities
- Set realistic retry limits
- Monitor queue depth and latency
- Scale workers based on load
- Use Redis persistence for job durability
- Consider job uniqueness to prevent duplicates
