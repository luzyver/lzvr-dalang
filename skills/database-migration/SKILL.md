---
name: database-migration
description: Execute database migrations across ORMs and platforms with zero-downtime strategies, data transformation, and rollback procedures. Use when migrating databases, changing schemas, performing data transformations, or implementing zero-downtime deployment strategies.
---

# Database Migration

Master database schema and data migrations across ORMs (Sequelize, TypeORM, Prisma), including rollback strategies and zero-downtime deployments.

## Running inside Dalang

- Use the migration tool the project already has (Yii migrations, Laravel, Prisma, plain SQL files); the ORMs in this skill are examples.
- Engine-specific rules (locking, online DDL, replication) come from `mysql` or `postgres`; on MySQL/MariaDB start every DDL with `USE <db>;` and name tables without the db prefix, so replication to slaves does not break.
- Migrations on shared or production databases are hard to undo: show the SQL and the rollback first, and run them only through db_query after the person agrees. A write that answers pending_approval waits for an admin: do not send it again.
- Back up affected tables (for example `CREATE TABLE bak_x LIKE x; INSERT INTO bak_x SELECT ...`) before destructive changes.
- Paths in this skill (`references/`) are relative to this skill's folder.

## When to Use This Skill

- Migrating between different ORMs
- Performing schema transformations
- Moving data between databases
- Implementing rollback procedures
- Zero-downtime deployments
- Database version upgrades
- Data model refactoring

## ORM Migrations

### Sequelize Migrations

```javascript
// migrations/20231201-create-users.js
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable("users", {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      email: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false,
      },
      createdAt: Sequelize.DATE,
      updatedAt: Sequelize.DATE,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable("users");
  },
};

// Run: npx sequelize-cli db:migrate
// Rollback: npx sequelize-cli db:migrate:undo
```

### TypeORM Migrations

```typescript
// migrations/1701234567-CreateUsers.ts
import { MigrationInterface, QueryRunner, Table } from "typeorm";

export class CreateUsers1701234567 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "users",
        columns: [
          {
            name: "id",
            type: "int",
            isPrimary: true,
            isGenerated: true,
            generationStrategy: "increment",
          },
          {
            name: "email",
            type: "varchar",
            isUnique: true,
          },
          {
            name: "created_at",
            type: "timestamp",
            default: "CURRENT_TIMESTAMP",
          },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("users");
  }
}

// Run: npm run typeorm migration:run
// Rollback: npm run typeorm migration:revert
```

### Prisma Migrations

```prisma
// schema.prisma
model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  createdAt DateTime @default(now())
}

// Generate migration: npx prisma migrate dev --name create_users
// Apply: npx prisma migrate deploy
```

## Schema Transformations

### Adding Columns with Defaults

```javascript
// Safe migration: add column with default
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("users", "status", {
      type: Sequelize.STRING,
      defaultValue: "active",
      allowNull: false,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("users", "status");
  },
};
```

### Renaming Columns (Zero Downtime)

```javascript
// Step 1 (migration): add the new column, nullable, no data yet
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("users", "full_name", {
      type: Sequelize.STRING,
    });
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("users", "full_name");
  },
};

// Step 2 (deploy): the application writes BOTH name and full_name on every
// insert/update, and still reads name. Only once every instance runs this
// version is it safe to backfill: otherwise writes made after the copy are lost.

// Step 3 (migration): backfill rows written before dual-write started.
// On large tables run it in batches (e.g. by primary key range).
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.sequelize.query(
      "UPDATE users SET full_name = name WHERE full_name IS NULL AND name IS NOT NULL",
    );
  },

  down: async () => {
    // Nothing to undo: name still holds every value.
  },
};

// Step 4 (deploy): read full_name, keep writing both, so the app can still roll back.
// Step 5 (deploy): write only full_name.

// Step 6 (migration): drop the old column
module.exports = {
  up: async (queryInterface) => {
    await queryInterface.removeColumn("users", "name");
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn("users", "name", {
      type: Sequelize.STRING,
    });
    // Restore the values, not just an empty column.
    await queryInterface.sequelize.query("UPDATE users SET name = full_name");
  },
};
```

### Changing Column Types

```javascript
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // For large tables, use multi-step approach

    // 1. Add new column
    await queryInterface.addColumn("users", "age_new", {
      type: Sequelize.INTEGER,
    });

    // 2. Copy and transform data
    await queryInterface.sequelize.query(`
      UPDATE users
      SET age_new = CAST(age AS INTEGER)
      WHERE age IS NOT NULL
    `);

    // 3. Drop old column
    await queryInterface.removeColumn("users", "age");

    // 4. Rename new column
    await queryInterface.renameColumn("users", "age_new", "age");
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn("users", "age", {
      type: Sequelize.STRING,
    });
  },
};
```

## Data Transformations

### Complex Data Migration

```javascript
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Get all records
    const [users] = await queryInterface.sequelize.query(
      "SELECT id, address_string FROM users",
    );

    // Transform each record
    for (const user of users) {
      const addressParts = user.address_string.split(",");

      await queryInterface.sequelize.query(
        `UPDATE users
         SET street = :street,
             city = :city,
             state = :state
         WHERE id = :id`,
        {
          replacements: {
            id: user.id,
            street: addressParts[0]?.trim(),
            city: addressParts[1]?.trim(),
            state: addressParts[2]?.trim(),
          },
        },
      );
    }

    // Drop old column
    await queryInterface.removeColumn("users", "address_string");
  },

  down: async (queryInterface, Sequelize) => {
    // Reconstruct original column
    await queryInterface.addColumn("users", "address_string", {
      type: Sequelize.STRING,
    });

    await queryInterface.sequelize.query(`
      UPDATE users
      SET address_string = CONCAT(street, ', ', city, ', ', state)
    `);

    await queryInterface.removeColumn("users", "street");
    await queryInterface.removeColumn("users", "city");
    await queryInterface.removeColumn("users", "state");
  },
};
```

## Rollback Strategies

### Transaction-Based Migrations

```javascript
module.exports = {
  up: async (queryInterface, Sequelize) => {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await queryInterface.addColumn(
        "users",
        "verified",
        { type: Sequelize.BOOLEAN, defaultValue: false },
        { transaction },
      );

      await queryInterface.sequelize.query(
        "UPDATE users SET verified = true WHERE email_verified_at IS NOT NULL",
        { transaction },
      );

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  },

  down: async (queryInterface) => {
    await queryInterface.removeColumn("users", "verified");
  },
};
```

### Checkpoint-Based Rollback

```javascript
module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Create backup table
    await queryInterface.sequelize.query(
      "CREATE TABLE users_backup AS SELECT * FROM users",
    );

    try {
      // Perform migration
      await queryInterface.addColumn("users", "new_field", {
        type: Sequelize.STRING,
      });

      // Verify migration
      const [result] = await queryInterface.sequelize.query(
        "SELECT COUNT(*) as count FROM users WHERE new_field IS NULL",
      );

      if (result[0].count > 0) {
        throw new Error("Migration verification failed");
      }

      // Drop backup
      await queryInterface.dropTable("users_backup");
    } catch (error) {
      // Restore from backup
      await queryInterface.sequelize.query("DROP TABLE users");
      await queryInterface.sequelize.query(
        "CREATE TABLE users AS SELECT * FROM users_backup",
      );
      await queryInterface.dropTable("users_backup");
      throw error;
    }
  },
};
```

## Additional patterns and templates

More detailed templates and worked examples live in `references/details.md`. Read that file for the full pattern library.

