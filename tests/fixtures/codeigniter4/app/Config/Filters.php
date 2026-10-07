<?php

namespace Config;

use CodeIgniter\Config\BaseConfig;
use CodeIgniter\Filters\CSRF;
use App\Filters\AuthFilter;

class Filters extends BaseConfig
{
    public array $aliases = [
        'csrf' => CSRF::class,
        'auth' => AuthFilter::class,
    ];

    public array $globals = [
        'before' => [
            // 'csrf',
        ],
        'after' => [],
    ];
}
