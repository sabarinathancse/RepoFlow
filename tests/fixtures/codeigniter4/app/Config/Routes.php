<?php

use CodeIgniter\Router\RouteCollection;

/**
 * @var RouteCollection $routes
 */
$routes->get('/', 'Home::index');
$routes->get('products/(:segment)', 'ProductController::show/$1');
$routes->match(['get', 'post'], 'contact', 'Home::contact');
// $routes->get('old', 'Home::old');

$routes->group('admin', ['filter' => 'auth'], function ($routes) {
    $routes->get('products', 'Admin\ProductController::index');
    $routes->post('products/store', 'Admin\ProductController::store');
    $routes->get('products/delete/(:num)', 'Admin\ProductController::delete/$1');
    $routes->get('products/export', 'Admin\ProductController::export');
});
$routes->get('admin/reports', 'Admin\ReportController::index');
$routes->resource('api/orders', ['controller' => 'Api\OrderController', 'only' => ['index', 'show']]);
