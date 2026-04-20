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

-- ===================== sales_rich (for advanced pivot testing) =====================
-- Dimensions: region(3), country(9), product_category(4), channel(3), segment(3), status(3)
-- Measures: revenue, cost (→ expr), quantity, discount_pct (→ median/stddev), is_paid (→ where)
CREATE TABLE IF NOT EXISTS sales_rich (
    id INT NOT NULL,
    order_date DATE,
    region VARCHAR(20),
    country VARCHAR(20),
    product_category VARCHAR(30),
    product VARCHAR(60),
    channel VARCHAR(20),
    customer_segment VARCHAR(20),
    status VARCHAR(20),
    quantity INT,
    unit_price DECIMAL(10,2),
    revenue DECIMAL(12,2),
    cost DECIMAL(12,2),
    discount_pct DECIMAL(5,2),
    is_paid TINYINT
) ENGINE=OLAP
DUPLICATE KEY(id)
DISTRIBUTED BY HASH(id) BUCKETS 1
PROPERTIES ("replication_num" = "1");

INSERT INTO sales_rich VALUES
-- APAC / Japan
(1,  '2024-01-05', 'APAC', 'Japan',     'Electronics', 'Laptop Pro',   'Online', 'Enterprise', 'paid',    5,  1200, 6000,  3800, 5.0,  1),
(2,  '2024-01-12', 'APAC', 'Japan',     'Electronics', 'Tablet X',     'Store',  'SMB',        'paid',    8,  450,  3600,  2200, 2.0,  1),
(3,  '2024-01-20', 'APAC', 'Japan',     'Furniture',   'Office Chair', 'Online', 'SMB',        'paid',    12, 300,  3600,  2100, 0.0,  1),
(4,  '2024-02-03', 'APAC', 'Japan',     'Software',    'CRM License',  'Online', 'Enterprise', 'pending', 30, 100,  3000,  400,  10.0, 0),
(5,  '2024-02-14', 'APAC', 'Japan',     'Electronics', 'Monitor 4K',   'Store',  'Consumer',   'paid',    4,  600,  2400,  1500, 0.0,  1),
-- APAC / Vietnam
(6,  '2024-01-07', 'APAC', 'Vietnam',   'Electronics', 'Tablet X',     'Online', 'SMB',        'paid',    6,  450,  2700,  1700, 3.0,  1),
(7,  '2024-01-15', 'APAC', 'Vietnam',   'Software',    'Analytics',    'Online', 'Enterprise', 'paid',    20, 200,  4000,  600,  5.0,  1),
(8,  '2024-02-01', 'APAC', 'Vietnam',   'Furniture',   'Standing Desk','Store',  'Consumer',   'refunded',2,  800,  1600,  1100, 0.0,  0),
(9,  '2024-02-20', 'APAC', 'Vietnam',   'Electronics', 'Laptop Pro',   'Online', 'SMB',        'paid',    3,  1200, 3600,  2280, 4.0,  1),
(10, '2024-03-05', 'APAC', 'Vietnam',   'Software',    'CRM License',  'Online', 'SMB',        'paid',    40, 100,  4000,  500,  8.0,  1),
-- APAC / Singapore
(11, '2024-01-10', 'APAC', 'Singapore', 'Electronics', 'Monitor 4K',   'Online', 'Enterprise', 'paid',    10, 600,  6000,  3700, 1.0,  1),
(12, '2024-02-08', 'APAC', 'Singapore', 'Furniture',   'Office Chair', 'Store',  'SMB',        'paid',    18, 300,  5400,  3150, 0.0,  1),
(13, '2024-02-25', 'APAC', 'Singapore', 'Software',    'Analytics',    'Online', 'Enterprise', 'pending', 15, 200,  3000,  450,  5.0,  0),
(14, '2024-03-12', 'APAC', 'Singapore', 'Electronics', 'Tablet X',     'Online', 'Consumer',   'paid',    25, 450,  11250, 6900, 2.0,  1),
(15, '2024-03-22', 'APAC', 'Singapore', 'Electronics', 'Laptop Pro',   'Store',  'Enterprise', 'paid',    7,  1200, 8400,  5300, 0.0,  1),
-- NA / USA
(16, '2024-01-03', 'NA',   'USA',       'Electronics', 'Laptop Pro',   'Online', 'Enterprise', 'paid',    15, 1200, 18000, 11400, 5.0, 1),
(17, '2024-01-18', 'NA',   'USA',       'Electronics', 'Monitor 4K',   'Online', 'SMB',        'paid',    8,  600,  4800,  2950, 2.0,  1),
(18, '2024-02-02', 'NA',   'USA',       'Furniture',   'Standing Desk','Store',  'Consumer',   'paid',    6,  800,  4800,  3200, 0.0,  1),
(19, '2024-02-12', 'NA',   'USA',       'Software',    'CRM License',  'Online', 'Enterprise', 'paid',    50, 100,  5000,  700,  12.0, 1),
(20, '2024-02-28', 'NA',   'USA',       'Electronics', 'Tablet X',     'Store',  'SMB',        'refunded',10, 450,  4500,  2800, 0.0,  0),
(21, '2024-03-10', 'NA',   'USA',       'Software',    'Analytics',    'Online', 'Enterprise', 'paid',    30, 200,  6000,  900,  8.0,  1),
(22, '2024-03-25', 'NA',   'USA',       'Electronics', 'Laptop Pro',   'Online', 'Consumer',   'pending', 4,  1200, 4800,  3000, 3.0,  0),
-- NA / Canada
(23, '2024-01-22', 'NA',   'Canada',    'Electronics', 'Tablet X',     'Online', 'SMB',        'paid',    12, 450,  5400,  3400, 4.0,  1),
(24, '2024-02-15', 'NA',   'Canada',    'Software',    'CRM License',  'Online', 'SMB',        'paid',    25, 100,  2500,  350,  10.0, 1),
(25, '2024-03-05', 'NA',   'Canada',    'Furniture',   'Office Chair', 'Store',  'Consumer',   'paid',    15, 300,  4500,  2700, 0.0,  1),
(26, '2024-03-18', 'NA',   'Canada',    'Electronics', 'Monitor 4K',   'Online', 'Enterprise', 'paid',    6,  600,  3600,  2250, 2.0,  1),
-- EU / Germany
(27, '2024-01-08', 'EU',   'Germany',   'Electronics', 'Laptop Pro',   'Online', 'Enterprise', 'paid',    10, 1200, 12000, 7600, 5.0,  1),
(28, '2024-01-28', 'EU',   'Germany',   'Furniture',   'Standing Desk','Store',  'SMB',        'paid',    5,  800,  4000,  2700, 0.0,  1),
(29, '2024-02-10', 'EU',   'Germany',   'Electronics', 'Monitor 4K',   'Online', 'Consumer',   'paid',    7,  600,  4200,  2620, 1.5,  1),
(30, '2024-02-22', 'EU',   'Germany',   'Software',    'Analytics',    'Online', 'Enterprise', 'paid',    22, 200,  4400,  660,  6.0,  1),
(31, '2024-03-09', 'EU',   'Germany',   'Electronics', 'Tablet X',     'Store',  'SMB',        'paid',    11, 450,  4950,  3100, 3.0,  1),
(32, '2024-03-30', 'EU',   'Germany',   'Software',    'CRM License',  'Online', 'SMB',        'pending', 35, 100,  3500,  500,  8.0,  0),
-- EU / France
(33, '2024-01-14', 'EU',   'France',    'Electronics', 'Laptop Pro',   'Store',  'Enterprise', 'paid',    6,  1200, 7200,  4560, 3.0,  1),
(34, '2024-02-05', 'EU',   'France',    'Furniture',   'Office Chair', 'Online', 'SMB',        'paid',    20, 300,  6000,  3550, 0.0,  1),
(35, '2024-02-18', 'EU',   'France',    'Electronics', 'Tablet X',     'Online', 'Consumer',   'refunded',9,  450,  4050,  2540, 0.0,  0),
(36, '2024-03-15', 'EU',   'France',    'Software',    'Analytics',    'Online', 'Enterprise', 'paid',    18, 200,  3600,  540,  5.0,  1),
-- EU / UK
(37, '2024-01-20', 'EU',   'UK',        'Electronics', 'Monitor 4K',   'Online', 'Enterprise', 'paid',    12, 600,  7200,  4500, 4.0,  1),
(38, '2024-02-08', 'EU',   'UK',        'Software',    'CRM License',  'Online', 'Enterprise', 'paid',    45, 100,  4500,  625,  10.0, 1),
(39, '2024-02-24', 'EU',   'UK',        'Furniture',   'Standing Desk','Store',  'Consumer',   'paid',    4,  800,  3200,  2160, 0.0,  1),
(40, '2024-03-12', 'EU',   'UK',        'Electronics', 'Laptop Pro',   'Online', 'SMB',        'paid',    5,  1200, 6000,  3800, 2.0,  1),
(41, '2024-04-01', 'APAC', 'Japan',     'Software',    'Analytics',    'Online', 'SMB',        'paid',    10, 200,  2000,  300,  5.0,  1),
(42, '2024-04-08', 'APAC', 'Vietnam',   'Electronics', 'Monitor 4K',   'Store',  'Consumer',   'paid',    5,  600,  3000,  1900, 0.0,  1),
(43, '2024-04-15', 'APAC', 'Singapore', 'Furniture',   'Standing Desk','Online', 'Enterprise', 'paid',    3,  800,  2400,  1620, 0.0,  1),
(44, '2024-04-20', 'NA',   'USA',       'Electronics', 'Tablet X',     'Online', 'Enterprise', 'paid',    18, 450,  8100,  5100, 6.0,  1),
(45, '2024-04-25', 'NA',   'Canada',    'Software',    'Analytics',    'Online', 'SMB',        'pending', 12, 200,  2400,  360,  5.0,  0),
(46, '2024-05-03', 'EU',   'Germany',   'Electronics', 'Tablet X',     'Online', 'Consumer',   'paid',    14, 450,  6300,  3950, 2.5,  1),
(47, '2024-05-09', 'EU',   'France',    'Software',    'CRM License',  'Online', 'SMB',        'paid',    28, 100,  2800,  400,  8.0,  1),
(48, '2024-05-15', 'EU',   'UK',        'Electronics', 'Monitor 4K',   'Store',  'Enterprise', 'refunded',8,  600,  4800,  3000, 0.0,  0),
(49, '2024-05-22', 'APAC', 'Japan',     'Electronics', 'Tablet X',     'Online', 'Consumer',   'paid',    16, 450,  7200,  4500, 3.0,  1),
(50, '2024-05-30', 'NA',   'USA',       'Furniture',   'Office Chair', 'Store',  'SMB',        'paid',    22, 300,  6600,  3900, 0.0,  1),
(51, '2024-06-04', 'APAC', 'Vietnam',   'Software',    'Analytics',    'Online', 'Enterprise', 'paid',    25, 200,  5000,  750,  7.0,  1),
(52, '2024-06-10', 'EU',   'Germany',   'Furniture',   'Office Chair', 'Online', 'Consumer',   'paid',    16, 300,  4800,  2850, 0.0,  1),
(53, '2024-06-15', 'NA',   'USA',       'Software',    'CRM License',  'Online', 'SMB',        'paid',    60, 100,  6000,  850,  12.0, 1),
(54, '2024-06-20', 'APAC', 'Singapore', 'Electronics', 'Laptop Pro',   'Online', 'Enterprise', 'pending', 4,  1200, 4800,  3050, 0.0,  0),
(55, '2024-06-28', 'EU',   'UK',        'Electronics', 'Tablet X',     'Store',  'SMB',        'paid',    10, 450,  4500,  2850, 2.0,  1);
