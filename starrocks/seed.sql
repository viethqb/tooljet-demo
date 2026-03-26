-- =====================================================
-- StarRocks Seed Data for Pivot Table Testing
-- =====================================================

CREATE DATABASE IF NOT EXISTS demo;
USE demo;

-- ===================== employees =====================
CREATE TABLE IF NOT EXISTS employees (
    id INT NOT NULL,
    name VARCHAR(100),
    department VARCHAR(50),
    region VARCHAR(20),
    status VARCHAR(20),
    salary DECIMAL(12,2),
    hire_date DATE
) ENGINE=OLAP
DUPLICATE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1");

INSERT INTO employees VALUES
(1,  'Olivia Nguyen',     'Engineering', 'APAC', 'Active',   85000, '2022-05-15'),
(2,  'Liam Patel',        'Engineering', 'NA',   'Active',   92000, '2021-09-20'),
(3,  'Sophia Reyes',      'Marketing',   'APAC', 'Active',   68000, '2023-01-01'),
(4,  'Jacob Hernandez',   'Marketing',   'NA',   'Inactive', 71000, '2022-11-10'),
(5,  'William Sanchez',   'Sales',       'EU',   'Active',   76000, '2021-01-07'),
(6,  'Ethan Morales',     'Engineering', 'EU',   'Active',   88000, '2021-11-05'),
(7,  'Mia Tiana',         'Sales',       'APAC', 'Inactive', 65000, '2022-11-21'),
(8,  'Lucas Ramirez',     'Marketing',   'EU',   'Active',   72000, '2023-03-31'),
(9,  'Alexander Vela',    'Sales',       'NA',   'Active',   79000, '2022-09-07'),
(10, 'Michael Reyes',     'Engineering', 'NA',   'Inactive', 95000, '2021-12-25'),
(11, 'Emma Chen',         'Sales',       'APAC', 'Active',   73000, '2022-06-14'),
(12, 'Noah Kim',          'Marketing',   'NA',   'Active',   67000, '2023-02-28'),
(13, 'Ava Johnson',       'Engineering', 'APAC', 'Active',   91000, '2021-03-10'),
(14, 'James Wilson',      'Sales',       'EU',   'Active',   81000, '2022-08-05'),
(15, 'Isabella Garcia',   'Marketing',   'EU',   'Inactive', 64000, '2023-05-20'),
(16, 'Benjamin Lee',      'Engineering', 'NA',   'Active',   97000, '2021-07-15'),
(17, 'Charlotte Davis',   'Sales',       'NA',   'Active',   74000, '2022-04-01'),
(18, 'Daniel Martinez',   'Marketing',   'APAC', 'Active',   69000, '2023-06-12'),
(19, 'Amelia Brown',      'Engineering', 'EU',   'Active',   89000, '2022-01-20'),
(20, 'Henry Taylor',      'Sales',       'APAC', 'Inactive', 70000, '2021-10-30');

-- ===================== sales_orders =====================
CREATE TABLE IF NOT EXISTS sales_orders (
    id INT NOT NULL,
    order_date DATE,
    customer VARCHAR(100),
    product_category VARCHAR(50),
    product VARCHAR(100),
    region VARCHAR(20),
    channel VARCHAR(20),
    quantity INT,
    unit_price DECIMAL(10,2),
    total_amount DECIMAL(12,2)
) ENGINE=OLAP
DUPLICATE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1");

INSERT INTO sales_orders VALUES
(1,  '2024-01-05', 'Acme Corp',       'Electronics', 'Laptop Pro',      'NA',   'Online',  5,  1200.00, 6000.00),
(2,  '2024-01-08', 'Beta Ltd',        'Electronics', 'Tablet X',        'EU',   'Store',   10, 450.00,  4500.00),
(3,  '2024-01-12', 'Gamma Inc',       'Furniture',   'Office Chair',    'APAC', 'Online',  20, 300.00,  6000.00),
(4,  '2024-01-15', 'Acme Corp',       'Electronics', 'Monitor 4K',      'NA',   'Online',  8,  600.00,  4800.00),
(5,  '2024-01-20', 'Delta Co',        'Furniture',   'Standing Desk',   'EU',   'Store',   3,  800.00,  2400.00),
(6,  '2024-02-01', 'Epsilon SA',      'Software',    'CRM License',     'APAC', 'Online',  50, 100.00,  5000.00),
(7,  '2024-02-05', 'Acme Corp',       'Software',    'Analytics Suite',  'NA',   'Online',  15, 200.00,  3000.00),
(8,  '2024-02-10', 'Beta Ltd',        'Electronics', 'Laptop Pro',      'EU',   'Online',  7,  1200.00, 8400.00),
(9,  '2024-02-14', 'Gamma Inc',       'Furniture',   'Office Chair',    'APAC', 'Store',   12, 300.00,  3600.00),
(10, '2024-02-20', 'Zeta Group',      'Electronics', 'Tablet X',        'NA',   'Store',   15, 450.00,  6750.00),
(11, '2024-03-01', 'Eta Partners',    'Software',    'CRM License',     'EU',   'Online',  30, 100.00,  3000.00),
(12, '2024-03-05', 'Delta Co',        'Furniture',   'Standing Desk',   'APAC', 'Online',  6,  800.00,  4800.00),
(13, '2024-03-10', 'Acme Corp',       'Electronics', 'Monitor 4K',      'NA',   'Online',  4,  600.00,  2400.00),
(14, '2024-03-15', 'Theta LLC',       'Software',    'Analytics Suite',  'EU',   'Store',   20, 200.00,  4000.00),
(15, '2024-03-20', 'Epsilon SA',      'Electronics', 'Laptop Pro',      'APAC', 'Online',  3,  1200.00, 3600.00),
(16, '2024-04-01', 'Beta Ltd',        'Furniture',   'Office Chair',    'EU',   'Online',  25, 300.00,  7500.00),
(17, '2024-04-05', 'Gamma Inc',       'Software',    'CRM License',     'APAC', 'Store',   40, 100.00,  4000.00),
(18, '2024-04-10', 'Zeta Group',      'Electronics', 'Tablet X',        'NA',   'Online',  20, 450.00,  9000.00),
(19, '2024-04-15', 'Acme Corp',       'Furniture',   'Standing Desk',   'NA',   'Store',   2,  800.00,  1600.00),
(20, '2024-04-20', 'Eta Partners',    'Software',    'Analytics Suite',  'EU',   'Online',  10, 200.00,  2000.00),
(21, '2024-05-01', 'Delta Co',        'Electronics', 'Laptop Pro',      'EU',   'Online',  4,  1200.00, 4800.00),
(22, '2024-05-05', 'Theta LLC',       'Furniture',   'Office Chair',    'NA',   'Store',   15, 300.00,  4500.00),
(23, '2024-05-10', 'Epsilon SA',      'Software',    'CRM License',     'APAC', 'Online',  60, 100.00,  6000.00),
(24, '2024-05-15', 'Acme Corp',       'Electronics', 'Monitor 4K',      'NA',   'Online',  6,  600.00,  3600.00),
(25, '2024-05-20', 'Beta Ltd',        'Electronics', 'Tablet X',        'EU',   'Store',   8,  450.00,  3600.00),
(26, '2024-06-01', 'Gamma Inc',       'Furniture',   'Standing Desk',   'APAC', 'Online',  5,  800.00,  4000.00),
(27, '2024-06-05', 'Zeta Group',      'Software',    'Analytics Suite',  'NA',   'Store',   12, 200.00,  2400.00),
(28, '2024-06-10', 'Eta Partners',    'Electronics', 'Laptop Pro',      'EU',   'Online',  6,  1200.00, 7200.00),
(29, '2024-06-15', 'Theta LLC',       'Furniture',   'Office Chair',    'APAC', 'Store',   18, 300.00,  5400.00),
(30, '2024-06-20', 'Delta Co',        'Software',    'CRM License',     'EU',   'Online',  35, 100.00,  3500.00);
