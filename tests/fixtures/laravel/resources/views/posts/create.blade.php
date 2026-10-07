@extends('layouts.app')
@section('content')
<form method="POST" action="{{ route('admin.posts.store') }}">
  @csrf
  <input name="title" value="{{ $post->title ?? '' }}">
</form>
@endsection
